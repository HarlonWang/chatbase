// Chat 可选模型目录：每家厂商都从各自的 /models 动态取，准入 / 展示 / 档位是 providers.ts 里各家的策略。
// 目录是给选择器看的；真正的强制在 resolveModel（纯函数，不查目录）。

import type { ChatContext, ProviderId, Tier } from "./config.js";
import { isRegionBlocked, fetchWithRelayFallback } from "./llm.js";
import {
  PROVIDER_LIST, canonicalModel, capsOf, minTierOf, providerOwning, hasModelPrice,
  type ModelCaps, type Provider,
} from "./providers.js";

export interface ModelEntry {
  id: string;
  name: string;
  minTier: Tier;
  provider: ProviderId;
  providerName: string;
  caps: ModelCaps;
}

export const FREE_MODELS: string[] = PROVIDER_LIST.flatMap((p) => p.catalog.free); // 免费可用白名单（各家 free 之并）
export const DEFAULT_MODEL: string = FREE_MODELS[0]; // 免费默认 & 一切越权/异常的兜底

/** 是否为「可提供」的模型：有厂商认领且过该厂商的准入规则（别名先换成正式 id） */
export function isOfferedModel(id: string): boolean {
  const model = canonicalModel(id);
  const p = providerOwning(model);
  return p != null && p.catalog.admit(model);
}

const tierAllows = (tier: Tier, minTier: Tier) => minTier === "user" || tier === "pro";

/**
 * 按 tier 决定实际模型——服务端强制，绝不只信客户端；越权/非法/已退役一律降级 DEFAULT_MODEL。
 * 纯函数无 fetch：形状规则与目录展示同源，不引入拉取失败的分支。返回的是正式 id（别名已换）。
 */
export function resolveModel(tier: Tier, requested: unknown): string {
  const model = canonicalModel(requested as string);
  if (!isOfferedModel(model)) return DEFAULT_MODEL;
  return tierAllows(tier, minTierOf(model)) ? model : DEFAULT_MODEL;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1h：成功结果缓存久一点，别每请求都打厂商
const FAILURE_TTL_MS = 60 * 1000;    // 任一家拉取失败只缓存 1 分钟，尽快自愈
let modelsCache: { list: ModelEntry[]; expiresAt: number } | null = null;
let lastGood: Partial<Record<ProviderId, string[]>> = {}; // 上次成功拉到的 id 列表；拉取失败时沿用，避免目录闪没

/** 测试用：清模型缓存 */
export function clearModelsCache(): void {
  modelsCache = null;
  lastGood = {};
}

const entry = (id: string, provider: Provider): ModelEntry => ({
  id, name: provider.catalog.displayName(id), minTier: minTierOf(id),
  provider: provider.id, providerName: provider.name, caps: capsOf(id),
});

/**
 * 一家厂商的动态目录：/models 过滤到「可提供」，别名 id 剔除（同一模型不重复展示）。
 * 未配 key 视为该家未启用：一个模型都不列（列了也调不通），不算失败。
 * 已启用但拉取失败：上次成功的列表 > 该家的 free 地板。
 */
async function fetchProviderModels(ctx: ChatContext, p: Provider): Promise<{ ids: string[]; ok: boolean }> {
  const apiKey = ctx.providers[p.id]?.apiKey;
  if (!apiKey) return { ids: [], ok: true };
  const floor = lastGood[p.id] ?? p.catalog.free.slice();
  try {
    const res = await fetchWithRelayFallback(ctx, "/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    }, p);
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[models] ${p.id} /models error ${res.status}: ${detail.slice(0, 200)}`);
      // 地区拒绝只降级列表；打同一前缀便于与 chat 失败同源观察
      if (isRegionBlocked(res.status, detail)) console.error("[openai] region_blocked (models)");
      return { ids: floor, ok: false };
    }
    const data: any = await res.json();
    // OpenAI / DeepSeek 是 { data: [{ id }] }；智谱 /api/v1/models 是 { models: [{ slug }] }
    const upstream = new Set<string>(
      (data?.data ?? data?.models ?? []).map((m: any) => m?.id ?? m?.slug).filter((id: unknown) => typeof id === "string"),
    );
    const fetched = [...upstream].filter((id) => p.catalog.admit(id) && !Object.hasOwn(p.aliases, id));
    const ids = [...new Set([...p.catalog.free, ...fetched])];
    logDrift(p, upstream, fetched);
    lastGood[p.id] = ids;
    return { ids, ok: true };
  } catch (e: any) {
    console.error(`[models] ${p.id} fetch failed:`, e?.message || e);
    return { ids: floor, ok: false };
  }
}

// 厂商目录与我方登记的两向漂移，固定前缀便于日志搜索：
//   unpriced —— 厂商新上、我方未登记牌价的模型正按 default 保守价在跑，熔断会偏早，要人补价
//   missing upstream —— 我方牌价 / 覆盖 / 别名目标里仍引用、厂商已不再列出的模型（改名或退役）
function logDrift(p: Provider, upstream: Set<string>, offered: string[]): void {
  for (const id of offered) {
    if (!hasModelPrice(id)) console.error(`[models] unpriced model offered: ${id}`);
  }
  const registered = new Set([...Object.keys(p.prices), ...Object.keys(p.overrides), ...Object.values(p.aliases)]);
  for (const id of registered) {
    if (p.catalog.admit(id) && !upstream.has(id)) console.error(`[models] ${p.id} registered model missing upstream: ${id}`);
  }
}

/**
 * 供选择器用的统一目录（缓存 1h）：按注册表顺序逐家追加，每家内部按该家的 sort 排。
 * 一家拉取失败只影响它自己那段。
 */
export async function fetchChatModels(ctx: ChatContext, now: number = Date.now()): Promise<ModelEntry[]> {
  if (modelsCache && modelsCache.expiresAt > now) return modelsCache.list;

  const results = await Promise.all(PROVIDER_LIST.map((p) => fetchProviderModels(ctx, p)));
  const ok = results.every((r) => r.ok);
  const list = PROVIDER_LIST.flatMap((p, i) => [...results[i].ids].sort(p.catalog.sort).map((id) => entry(id, p)));
  // 失败降级只短缓存，避免一次冷拉失败让 chip 全局隐身 1h
  modelsCache = { list, expiresAt: now + (ok ? CACHE_TTL_MS : FAILURE_TTL_MS) };
  return list;
}
