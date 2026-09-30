import { describe, it, expect, afterEach, vi } from "vitest";
import {
  resolveModel, fetchChatModels, clearModelsCache, FREE_MODELS, DEFAULT_MODEL, type ModelEntry,
} from "../src/models.js";
import type { ChatContext } from "../src/config.js";

const CACHE_1H = 60 * 60 * 1000;
const ctxWith = (providers: ChatContext["providers"]) => ({ providers }) as ChatContext;

describe("resolveModel（服务端模型强制）", () => {
  it("free：请求非白名单模型 → 降级默认", () => {
    expect(resolveModel("user", "gpt-5.5")).toBe(DEFAULT_MODEL);
    expect(resolveModel("anonymous", "gpt-5.5")).toBe(DEFAULT_MODEL);
  });
  it("free：请求白名单模型 → 用之", () => {
    expect(resolveModel("user", "gpt-5.6-luna")).toBe("gpt-5.6-luna");
  });
  it("free：旧默认 gpt-5.4 已不在白名单 → 降级默认", () => {
    expect(resolveModel("user", "gpt-5.4")).toBe(DEFAULT_MODEL);
  });
  it("free：无 requested → 默认", () => {
    expect(resolveModel("user", undefined)).toBe(DEFAULT_MODEL);
  });
  it("pro：分档模型（sol/terra/luna）→ 用之", () => {
    expect(resolveModel("pro", "gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(resolveModel("pro", "gpt-5.6-terra")).toBe("gpt-5.6-terra");
    expect(resolveModel("pro", "gpt-5.6-luna")).toBe("gpt-5.6-luna");
  });
  it("pro：已退役的 gpt-5.4 / 5.5 → 降级默认", () => {
    expect(resolveModel("pro", "gpt-5.4")).toBe(DEFAULT_MODEL);
    expect(resolveModel("pro", "gpt-5.5")).toBe(DEFAULT_MODEL);
  });
  it("free：分档模型不在白名单 → 降级默认", () => {
    expect(resolveModel("user", "gpt-5.6-sol")).toBe(DEFAULT_MODEL);
  });
  it("pro：新一代 / 新分档名 / 任意后缀，只要 ≥ 5.6 即放行（新模型零登记上架）", () => {
    expect(resolveModel("pro", "gpt-6-astra")).toBe("gpt-6-astra");
    expect(resolveModel("pro", "gpt-6")).toBe("gpt-6");                  // 裸名 6.0 ≥ 5.6
    expect(resolveModel("pro", "gpt-6.1-nova")).toBe("gpt-6.1-nova");    // 未见过的分档名
    expect(resolveModel("pro", "gpt-5.7-terra")).toBe("gpt-5.7-terra");
    expect(resolveModel("pro", "gpt-7")).toBe("gpt-7");
    expect(resolveModel("pro", "gpt-5.6-chat-latest")).toBe("gpt-5.6-chat-latest"); // 多段后缀
  });
  it("pro：旧于阈值 / 日期快照 / 非法 → 降级默认", () => {
    expect(resolveModel("pro", "gpt-5-pro")).toBe(DEFAULT_MODEL);        // 5.0 变体，被版本阈值挡
    expect(resolveModel("pro", "gpt-5.5-codex")).toBe(DEFAULT_MODEL);
    expect(resolveModel("pro", "gpt-5.5-2026-04-23")).toBe(DEFAULT_MODEL);
    expect(resolveModel("pro", "gpt-5.6-sol-2026-06-23")).toBe(DEFAULT_MODEL); // ≥ 5.6 但是日期快照
    expect(resolveModel("pro", "gpt-6-astra-2026-09-10")).toBe(DEFAULT_MODEL);
    expect(resolveModel("pro", "gpt-5.2")).toBe(DEFAULT_MODEL);
    expect(resolveModel("pro", "gpt-5.3-luna")).toBe(DEFAULT_MODEL);     // 分档也受阈值约束
    expect(resolveModel("pro", "gpt-5")).toBe(DEFAULT_MODEL);            // 5.0 < 5.6
    expect(resolveModel("pro", "gpt-4o")).toBe(DEFAULT_MODEL);           // 4o：major 后非 . 非 -
    expect(resolveModel("pro", "gpt-realtime-2.1")).toBe(DEFAULT_MODEL); // 非数字 major
    expect(resolveModel("pro", "gpt-image-2")).toBe(DEFAULT_MODEL);
    expect(resolveModel("pro", 123)).toBe(DEFAULT_MODEL);
    expect(resolveModel("pro", undefined)).toBe(DEFAULT_MODEL);
  });
});

// 按厂商域名分流的 /models 桩：值为 id 数组（成功）、Error（网络异常）或 { status }（HTTP 失败）
type HostSpec = string[] | Error | { status?: number } | undefined;
function stubModels(byHost: Record<string, HostSpec>) {
  return vi.fn().mockImplementation(async (url: any) => {
    const host = new URL(String(url)).hostname;
    const spec = byHost[host];
    if (spec instanceof Error) throw spec;
    if (Array.isArray(spec)) return { ok: true, json: async () => ({ data: spec.map((id) => ({ id })) }) };
    return { ok: false, status: spec?.status ?? 500, text: async () => "" };
  });
}
const OPENAI = "api.openai.com", DEEPSEEK = "api.deepseek.com", ZHIPU = "open.bigmodel.cn";
const BOTH_KEYS = ctxWith({ openai: { apiKey: "sk-test" }, deepseek: { apiKey: "sk-ds" } });
const OPENAI_ONLY = ctxWith({ openai: { apiKey: "k" } });

describe("fetchChatModels", () => {
  const ctx = ctxWith({ openai: { apiKey: "sk-test" } });
  afterEach(() => { clearModelsCache(); vi.unstubAllGlobals(); });
  // 统一目录 = OpenAI 动态段 + 静态厂商段；本组只断言 OpenAI 段的准入与排序
  const openaiIds = (list: ModelEntry[]) => list.filter((m) => m.provider === "openai").map((m) => m.id);

  it("只留可提供的模型（排除变体/快照/已退役版本）+ 打 tier 标签", async () => {
    // 模拟真实 /models 的混杂输出
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [
        { id: "gpt-5.4" }, { id: "gpt-5.5" }, { id: "gpt-5.6-sol" },
        { id: "gpt-5.5-2026-04-23" }, { id: "gpt-5.5-pro" }, { id: "gpt-5-mini" },
        { id: "gpt-5.4-pro" }, { id: "gpt-5.2" }, { id: "gpt-5" },
        { id: "text-embedding-3" }, { id: "whisper-1" },
      ] }),
    }));
    const list = await fetchChatModels(ctx, 1000);
    const ids = openaiIds(list);
    expect(ids).toEqual(["gpt-5.6-luna", "gpt-5.6-sol"]); // 干净子集 + FREE_MODELS 必含，同版本字母序
    expect(list.find((m) => m.id === "gpt-5.6-luna")!.minTier).toBe("user");
    expect(list.find((m) => m.id === "gpt-5.6-sol")!.minTier).toBe("pro"); // 新版安全默认 pro
    expect(list.find((m) => m.id === "gpt-5.6-sol")!.name).toBe("GPT-5.6 Sol");
    expect(ids).not.toContain("gpt-5.4"); // 退役：低于 MIN_OFFERED_MINOR
    expect(ids).not.toContain("gpt-5.5");
  });

  it("5.6 三档：透出并标 pro，展示名带档位，同版本按 id 字母序", async () => {
    // 贴近 2026-07 实际 /models 返回：三档在列、无裸 5.6、混杂大量变体
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [
        { id: "gpt-5.6-luna" }, { id: "gpt-5.6-sol" }, { id: "gpt-5.6-terra" },
        { id: "gpt-5.4" }, { id: "gpt-5.5" }, { id: "gpt-5.5-pro" },
        { id: "gpt-realtime-2.1" }, { id: "gpt-5.4-mini" }, { id: "gpt-5.3-codex" },
      ] }),
    }));
    const list = await fetchChatModels(ctx, 3000);
    expect(openaiIds(list)).toEqual([
      "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra",
    ]);
    expect(list.find((m) => m.id === "gpt-5.6-sol")!.name).toBe("GPT-5.6 Sol");
    expect(list.find((m) => m.id === "gpt-5.6-luna")!.name).toBe("GPT-5.6 Luna");
    expect(list.filter((m) => m.provider === "openai").every((m) => m.id === "gpt-5.6-luna" || m.minTier === "pro")).toBe(true);
  });

  it("新一代与新分档零登记上架：版本升序，同版本内裸别名在前；展示名按后缀分词", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [
        { id: "gpt-6-astra" }, { id: "gpt-6-astra-2026-09-10" }, { id: "gpt-6" },
        { id: "gpt-6.1-nova" }, { id: "gpt-5.6-sol" }, { id: "gpt-5.5-pro" },
        { id: "gpt-6-chat-latest" },
      ] }),
    }));
    const list = await fetchChatModels(ctx, 3500);
    expect(openaiIds(list)).toEqual([
      "gpt-5.6-luna", "gpt-5.6-sol", "gpt-6", "gpt-6-astra", "gpt-6-chat-latest", "gpt-6.1-nova",
    ]);
    expect(list.find((m) => m.id === "gpt-6-astra")!.name).toBe("GPT-6 Astra");
    expect(list.find((m) => m.id === "gpt-6")!.name).toBe("GPT-6");
    expect(list.find((m) => m.id === "gpt-6-chat-latest")!.name).toBe("GPT-6 Chat Latest");
    expect(list.find((m) => m.id === "gpt-6.1-nova")!.name).toBe("GPT-6.1 Nova");
    expect(list.find((m) => m.id === "gpt-6-astra")!.minTier).toBe("pro");
  });

  it("未登记牌价的模型进目录时打 [models] unpriced 日志，已登记的不打", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "gpt-6-astra" }, { id: "gpt-6.1-nova" }, { id: "gpt-5.6-sol" }] }),
    }));
    await fetchChatModels(ctx, 3600);
    const msgs = err.mock.calls.map((c) => String(c[0]));
    expect(msgs).toContain("[models] unpriced model offered: gpt-6.1-nova");
    expect(msgs.some((m) => m.includes("gpt-6-astra") || m.includes("gpt-5.6-sol"))).toBe(false);
    err.mockRestore();
  });

  it("裸别名与分档同现时不去重（两者都展示）", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [
        { id: "gpt-5.4" }, { id: "gpt-5.6" }, { id: "gpt-5.6-sol" },
      ] }),
    }));
    const list = await fetchChatModels(ctx, 4000);
    expect(openaiIds(list)).toEqual(["gpt-5.6", "gpt-5.6-luna", "gpt-5.6-sol"]);
    expect(list.find((m) => m.id === "gpt-5.6")!.name).toBe("GPT-5.6");
  });

  it("OpenAI 失败 → OpenAI 段降级仅 FREE_MODELS，DeepSeek 段不受牵连", async () => {
    vi.stubGlobal("fetch", stubModels({ [OPENAI]: { status: 500 }, [DEEPSEEK]: ["deepseek-v4-pro", "deepseek-flash"] }));
    const list = await fetchChatModels(BOTH_KEYS, 2000);
    expect(openaiIds(list)).toEqual(FREE_MODELS);
    expect(list.filter((m) => m.provider === "deepseek").map((m) => m.id)).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
  });

  it("DeepSeek 失败 → 它那段为空（无免费地板），OpenAI 段照常；整体按失败短缓存", async () => {
    const f = stubModels({ [OPENAI]: ["gpt-5.6-sol"], [DEEPSEEK]: new Error("ECONNRESET") });
    vi.stubGlobal("fetch", f);
    const t0 = 8_000_000;
    const list = await fetchChatModels(BOTH_KEYS, t0);
    expect(list.map((m) => m.id)).toEqual(["gpt-5.6-luna", "gpt-5.6-sol"]);
    await fetchChatModels(BOTH_KEYS, t0 + 70_000);   // > 失败 TTL，重拉
    expect(f).toHaveBeenCalledTimes(4);
  });

  it("拉取失败时沿用该家上次成功的列表，目录不闪没", async () => {
    const f = vi.fn()
      .mockImplementationOnce(stubModels({ [OPENAI]: ["gpt-5.6-sol"], [DEEPSEEK]: ["deepseek-flash"] }))
      .mockImplementationOnce(stubModels({ [OPENAI]: ["gpt-5.6-sol"], [DEEPSEEK]: ["deepseek-flash"] }))
      .mockImplementation(stubModels({ [OPENAI]: { status: 500 }, [DEEPSEEK]: { status: 503 } }));
    vi.stubGlobal("fetch", f);
    const t0 = 9_000_000;
    expect((await fetchChatModels(BOTH_KEYS, t0)).map((m) => m.id)).toEqual(["gpt-5.6-luna", "gpt-5.6-sol", "deepseek-flash"]);
    const later = await fetchChatModels(BOTH_KEYS, t0 + CACHE_1H + 1);
    expect(later.map((m) => m.id)).toEqual(["gpt-5.6-luna", "gpt-5.6-sol", "deepseek-flash"]);
  });

  it("未配 key 的厂商视为未启用：不 fetch、那段为空、不算失败（成功长缓存）", async () => {
    const f = stubModels({ [OPENAI]: ["gpt-5.6-sol"] });
    vi.stubGlobal("fetch", f);
    const t0 = 10_000_000;
    const list = await fetchChatModels(OPENAI_ONLY, t0);
    expect(list.map((m) => m.provider)).toEqual(["openai", "openai"]);
    await fetchChatModels(OPENAI_ONLY, t0 + 70_000);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("未配 OpenAI key 时连免费地板 luna 也不列：目录不能出现必然 502 的项", async () => {
    const f = stubModels({ [DEEPSEEK]: ["deepseek-flash"] });
    vi.stubGlobal("fetch", f);
    const list = await fetchChatModels(ctxWith({ deepseek: { apiKey: "k" } }), 10_500_000);
    expect(list.map((m) => m.id)).toEqual(["deepseek-flash"]);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("未配 key 不复用上次成功列表：key 被撤后该段立即消失", async () => {
    vi.stubGlobal("fetch", stubModels({ [OPENAI]: ["gpt-5.6-sol"], [DEEPSEEK]: ["deepseek-flash"] }));
    const t0 = 10_800_000;
    expect((await fetchChatModels(BOTH_KEYS, t0)).map((m) => m.provider)).toEqual(["openai", "openai", "deepseek"]);
    const after = await fetchChatModels(OPENAI_ONLY, t0 + CACHE_1H + 1);
    expect(after.map((m) => m.provider)).toEqual(["openai", "openai"]);
  });

  it("厂商列表里仍出现的别名旧 id 不进目录（同一模型不重复展示）", async () => {
    vi.stubGlobal("fetch", stubModels({ [OPENAI]: [], [DEEPSEEK]: ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-pro"] }));
    const list = await fetchChatModels(BOTH_KEYS, 11_000_000);
    expect(list.filter((m) => m.provider === "deepseek").map((m) => m.id)).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
  });

  it("漂移日志：我方登记（牌价 / 别名目标）而厂商已不再列出的模型打 missing upstream", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", stubModels({ [OPENAI]: ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"], [DEEPSEEK]: ["deepseek-v4-pro"] }));
    await fetchChatModels(BOTH_KEYS, 12_000_000);
    const msgs = err.mock.calls.map((c) => String(c[0]));
    expect(msgs).toContain("[models] deepseek registered model missing upstream: deepseek-flash");
    expect(msgs.filter((m) => m.includes("missing upstream"))).toHaveLength(1); // OpenAI 全在列，gpt-5.4/5.5 不过准入不算
    err.mockRestore();
  });

  it("缓存命中不重复 fetch", async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: "gpt-5.4" }] }) });
    vi.stubGlobal("fetch", f);
    await fetchChatModels(ctx, 5000);
    await fetchChatModels(ctx, 5000 + 1000); // 1h 内
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("拉取失败只短缓存（1min），到期即重试自愈", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500 }) // 冷拉失败 → 降级仅 FREE
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: "gpt-5.6-sol" }, { id: "gpt-5.6-terra" }] }) });
    vi.stubGlobal("fetch", f);
    const t0 = 1_000_000;
    expect(openaiIds(await fetchChatModels(ctx, t0))).toEqual(FREE_MODELS);
    // 70s 后（> 失败 TTL 60s）应重试并拿到完整列表
    expect(openaiIds(await fetchChatModels(ctx, t0 + 70_000)))
      .toEqual(["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("成功结果长缓存：70s 内不重拉", async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: "gpt-5.4" }, { id: "gpt-5.5" }] }) });
    vi.stubGlobal("fetch", f);
    const t0 = 2_000_000;
    await fetchChatModels(ctx, t0);
    await fetchChatModels(ctx, t0 + 70_000); // 远小于 1h
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("resolveModel · DeepSeek（动态目录 + 别名）", () => {
  it("DeepSeek 全部 Pro 专属：匿名 / 登录降级默认，Pro 可用", () => {
    expect(resolveModel("anonymous", "deepseek-flash")).toBe(DEFAULT_MODEL);
    expect(resolveModel("user", "deepseek-flash")).toBe(DEFAULT_MODEL);
    expect(resolveModel("user", "deepseek-v4-pro")).toBe(DEFAULT_MODEL);
    expect(resolveModel("pro", "deepseek-flash")).toBe("deepseek-flash");
    expect(resolveModel("pro", "deepseek-v4-pro")).toBe("deepseek-v4-pro");
  });
  it("旧名经别名换成正式 id 再裁决：Pro 拿到新名，非 Pro 仍降级", () => {
    expect(resolveModel("pro", "deepseek-v4-flash")).toBe("deepseek-flash");
    expect(resolveModel("pro", "deepseek-v4-flash-vision-exp")).toBe("deepseek-flash");
    expect(resolveModel("user", "deepseek-v4-flash")).toBe(DEFAULT_MODEL);
  });
  it("形状合法的新型号零登记上架；旧名 chat/reasoner、实验型、无人认领的 id 降级默认", () => {
    expect(resolveModel("pro", "deepseek-v5-pro")).toBe("deepseek-v5-pro");
    expect(resolveModel("pro", "deepseek-chat")).toBe(DEFAULT_MODEL);
    expect(resolveModel("pro", "deepseek-reasoner")).toBe(DEFAULT_MODEL);
    expect(resolveModel("pro", "deepseek-vl-exp")).toBe(DEFAULT_MODEL);
    expect(resolveModel("pro", "claude-4")).toBe(DEFAULT_MODEL);
  });
});

describe("fetchChatModels · 统一目录形状", () => {
  afterEach(() => { clearModelsCache(); vi.unstubAllGlobals(); });

  it("按注册表顺序 OpenAI 段在前、DeepSeek 段随后；每条带 provider / providerName / caps，展示名从 id 推导", async () => {
    vi.stubGlobal("fetch", stubModels({ [OPENAI]: ["gpt-5.6-sol"], [DEEPSEEK]: ["deepseek-v4-pro", "deepseek-flash"] }));
    const list = await fetchChatModels(BOTH_KEYS, 9000);
    expect(list.map((m) => m.id)).toEqual(["gpt-5.6-luna", "gpt-5.6-sol", "deepseek-flash", "deepseek-v4-pro"]);
    const luna = list.find((m) => m.id === "gpt-5.6-luna");
    expect(luna).toMatchObject({ provider: "openai", providerName: "OpenAI", caps: { images: true, search: true } });
    const flash = list.find((m) => m.id === "deepseek-flash");
    expect(flash).toMatchObject({
      name: "DeepSeek Flash", minTier: "pro", provider: "deepseek", providerName: "DeepSeek",
      caps: { images: true, search: false },
    });
    expect(list.find((m) => m.id === "deepseek-v4-pro")).toMatchObject({ name: "DeepSeek V4 Pro", minTier: "pro" });
  });
});

describe("Zhipu 目录：/api/v1/models 的 { models: [{ slug }] } 形状", () => {
  afterEach(() => { clearModelsCache(); vi.unstubAllGlobals(); });

  it("slug 当 id 用，准入只留 glm-5.3 / glm-5.3-flash", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: any) => {
      const host = new URL(String(url)).hostname;
      if (host === ZHIPU) return { ok: true, json: async () => ({ models: [
        { slug: "glm-5.3", input_modalities: ["text"] },
        { slug: "glm-5.3-flash", input_modalities: ["text", "image"] },
        { slug: "glm-5-turbo", input_modalities: ["text"] },
      ] }) };
      return { ok: true, json: async () => ({ data: [] }) };
    }));
    const list = await fetchChatModels(ctxWith({ openai: { apiKey: "k" }, zhipu: { apiKey: "z" } }), 0);
    const zh = list.filter((m) => m.provider === "zhipu");
    expect(zh.map((m) => m.id)).toEqual(["glm-5.3", "glm-5.3-flash"]);
    expect(zh[0]).toMatchObject({ name: "GLM-5.3", providerName: "Zhipu AI", minTier: "pro", caps: { images: false, search: true } });
    expect(zh[1].caps.images).toBe(true);
  });

  it("未配 zhipu apiKey 时不打智谱、目录里没有 glm", async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
    vi.stubGlobal("fetch", f);
    const list = await fetchChatModels(OPENAI_ONLY, 0);
    expect(list.some((m) => m.provider === "zhipu")).toBe(false);
    expect(f.mock.calls.some(([url]) => String(url).includes(ZHIPU))).toBe(false);
  });
});
