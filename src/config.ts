// 宿主与本库的唯一配置边界。本库不认识用户与订阅：档位由宿主的 resolveTier 裁决后传入。

import { resolveFreeModels } from "./models.js";

export type Tier = "anonymous" | "user" | "pro";

export type ProviderId = "openai" | "deepseek" | "zhipu";

export type TierInfo =
  | { tier: "anonymous" }
  | { tier: "user" | "pro"; userSub: string }
  | { authInvalid: true };

/** 宿主档位裁决。抛错视为宿主故障（500），不降级放行。 */
export type TierResolver = (request: Request) => Promise<TierInfo> | TierInfo;

export interface ProviderCredentials {
  apiKey: string;
  /** OpenAI 403 地区拒绝时的非 CF 中转；仅 openai 条目读取 */
  relay?: { url: string; token: string };
}

export interface CreditsConfig {
  /** 档位日授予额（credits/天） */
  dailyGrant: Record<Tier, number>;
  /** feature → credits */
  rateCard: Record<string, number>;
  /** 全局日预算（微美元）。匿名 / 登录分池，user 与 pro 同池 */
  globalBudgetMicros: { anonymous: number; user: number };
}

export interface ModelsConfig {
  /**
   * 免费档（anonymous / user）可用的模型，首个为默认模型；须属于已启用的厂商。
   * 不给则取已启用厂商的内置免费模型；两者皆空时解析上下文直接抛错。
   */
  free?: string[];
}

export interface LoggingConfig {
  /** chat_logs 保留天数（正整数）：day 早于等于「今天 - N 天」的行由 Chat.purge 删除。不给则永久保留 */
  retentionDays?: number;
}

export interface ChatContextInput {
  /** 请求体里的 context，形状由宿主与其客户端约定 */
  title?: string;
  summary?: string;
  sourceUrl?: string;
  [key: string]: unknown;
}

export interface PromptConfig {
  /** system prompt 里的产品名 */
  brand: string;
  /** 整段覆盖 system prompt；给了则 brand 与 context 不再生效 */
  system?: (lang: "zh" | "en", flags: { imageGeneration: boolean; search: boolean }) => string;
  /** 把请求体的 context 渲染为 system prompt 附加段；不给则忽略 context */
  context?: (lang: "zh" | "en", context: ChatContextInput) => string;
}

export interface BlockedEvent {
  reason: "quota_global" | "quota_device";
  tier: Tier;
  feature: string;
  installId: string;
  userSub: string | null;
  request: Request | null;
  waitUntil: ((p: Promise<unknown>) => void) | null;
}

export interface ChatConfig {
  db: D1Database;
  /** 读 chat_images / chat_voice 两个 key 做运行时调参；不给用内置默认 */
  kv?: KVNamespace;
  /** 生成图落盘；不给则生图能力关闭 */
  images?: R2Bucket;
  /** 启用的厂商及凭据，至少一家；未列出的厂商其模型不进目录 */
  providers: Partial<Record<ProviderId, ProviderCredentials>>;
  models?: ModelsConfig;
  resolveTier: TierResolver;
  prompt: PromptConfig;
  credits?: Partial<CreditsConfig>;
  /** 写 chat_logs，默认 true；给对象即开启并附保留策略 */
  logging?: boolean | LoggingConfig;
  /** 配额拦截回调（埋点用），必须自吞异常 */
  onBlocked?: (event: BlockedEvent) => void;
}

/** 底层出口（callChat / transcribeAudio / fetchChatModels）只需要厂商凭据；宿主的后台任务直接传这个形状 */
export interface ProviderContext {
  providers: Partial<Record<ProviderId, ProviderCredentials>>;
}

/** 解析后的运行时上下文：所有模块只认它，不认 env */
export interface ChatContext {
  db: D1Database;
  kv: KVNamespace | null;
  images: R2Bucket | null;
  providers: Partial<Record<ProviderId, ProviderCredentials>>;
  /** 解析后的免费白名单，非空，首个为默认模型 */
  freeModels: string[];
  resolveTier: TierResolver;
  prompt: PromptConfig;
  credits: CreditsConfig;
  logging: boolean;
  /** chat_logs 保留天数；null 为永久保留，purge 不删 */
  logRetentionDays: number | null;
  onBlocked: ((event: BlockedEvent) => void) | null;
  /** 端点挂载点（来自 createChat 的 options），生成图 URL 以它为前缀 */
  basePath: string;
}

export const DEFAULT_CREDITS: CreditsConfig = {
  dailyGrant: { anonymous: 5, user: 10, pro: 100 },
  rateCard: { chat: 1, chat_search: 3, chat_voice: 1, chat_image_generation: 10 },
  globalBudgetMicros: { anonymous: 2_000_000, user: 13_000_000 },
};

export interface CreateChatOptions {
  /** 默认 "/api"，端点为 <basePath>/chat/* 与 <basePath>/quota */
  basePath?: string;
}

/** 模型配置不自洽（默认模型所属厂商未启用等）时抛错：宿主首个请求即 500 并带明确日志，不留到免费用户逐条 502 */
export function resolveContext(config: ChatConfig, basePath = "/api"): ChatContext {
  return {
    db: config.db,
    kv: config.kv ?? null,
    images: config.images ?? null,
    providers: config.providers,
    freeModels: resolveFreeModels(config.providers, config.models?.free),
    resolveTier: config.resolveTier,
    prompt: config.prompt,
    credits: {
      dailyGrant: { ...DEFAULT_CREDITS.dailyGrant, ...(config.credits?.dailyGrant ?? {}) },
      rateCard: { ...DEFAULT_CREDITS.rateCard, ...(config.credits?.rateCard ?? {}) },
      globalBudgetMicros: { ...DEFAULT_CREDITS.globalBudgetMicros, ...(config.credits?.globalBudgetMicros ?? {}) },
    },
    logging: config.logging !== false,
    logRetentionDays: resolveRetentionDays(config.logging),
    onBlocked: config.onBlocked ?? null,
    basePath,
  };
}

function resolveRetentionDays(logging: ChatConfig["logging"]): number | null {
  const days = typeof logging === "object" ? logging.retentionDays : undefined;
  if (days === undefined) return null;
  if (!Number.isInteger(days) || days < 1) throw new Error(`[chatbase] logging.retentionDays must be a positive integer, got ${days}`);
  return days;
}

/** 按 env 对象身份缓存解析结果：Workers 里同一 isolate 内 env 恒同一引用 */
export function memoizeResolver<TEnv extends object>(resolve: (env: TEnv) => ChatConfig, basePath = "/api") {
  const cache = new WeakMap<TEnv, ChatContext>();
  return (env: TEnv): ChatContext => {
    let ctx = cache.get(env);
    if (!ctx) {
      ctx = resolveContext(resolve(env), basePath);
      cache.set(env, ctx);
    }
    return ctx;
  };
}
