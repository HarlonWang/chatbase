import { describe, it, expect, afterEach, vi } from "vitest";
import { handleChatModels } from "../../src/handlers/models.js";
import { clearModelsCache, resolveFreeModels } from "../../src/models.js";
import type { ChatContext } from "../../src/config.js";
import { json } from "./helpers.js";

afterEach(() => { clearModelsCache(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const req = (method: string) => new Request("https://api.trendingai.cn/api/chat/models", { method });
const ctxWith = (providers: ChatContext["providers"], free?: string[]) =>
  ({ providers, freeModels: resolveFreeModels(providers, free) }) as ChatContext;
const openaiOnly = ctxWith({ openai: { apiKey: "k" } });

describe("GET /api/chat/models", () => {
  it("非 GET → 405", async () => {
    const res = await handleChatModels(req("POST"), openaiOnly);
    expect(res.status).toBe(405);
  });

  it("返回模型目录（含 tier 标签）", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "gpt-5.6-sol" }, { id: "gpt-5.4" }] }),
    }));
    const res = await handleChatModels(req("GET"), openaiOnly);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.models.map((m: any) => m.id)).toContain("gpt-5.6-sol");
    expect(body.models.find((m: any) => m.id === "gpt-5.6-sol").minTier).toBe("pro");
    expect(body.models.find((m: any) => m.id === "gpt-5.6-luna").minTier).toBe("user");
    expect(body.models.map((m: any) => m.id)).not.toContain("gpt-5.4"); // 已退役，不再进目录
  });

  it("目录每条带 provider / providerName / caps（契约 v2 新增字段），DeepSeek 段随 OpenAI 段之后", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => ({ data: String(url).includes("deepseek")
        ? [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }]
        : [{ id: "gpt-5.6-sol" }] }),
    })));
    const res = await handleChatModels(req("GET"), ctxWith({ openai: { apiKey: "k" }, deepseek: { apiKey: "k2" } }));
    const body = await json(res);
    for (const m of body.models) {
      expect(m).toMatchObject({ provider: expect.any(String), providerName: expect.any(String), caps: { images: expect.any(Boolean), search: expect.any(Boolean) } });
    }
    expect(body.models.map((m: any) => m.provider)).toEqual(["openai", "openai", "deepseek", "deepseek"]);
    expect(body.models.find((m: any) => m.id === "deepseek-flash")).toMatchObject({
      providerName: "DeepSeek", minTier: "pro", caps: { images: true, search: false },
    });
    expect(body.models.find((m: any) => m.id === "deepseek-v4-pro").caps.images).toBe(false);
  });

  // 客户端不硬编码默认模型 id、也不猜排序，全靠这个字段——契约的两个不变量都钉住：
  // default 必须指向目录中的一项，且那一项必须免费（默认不能是 Pro 专属）
  it("default 指向目录内的免费项", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "gpt-5.6-sol" }, { id: "gpt-5.6-terra" }] }),
    }));
    const res = await handleChatModels(req("GET"), openaiOnly);
    const body = await json(res);
    const entry = body.models.find((m: any) => m.id === body.default);
    expect(entry).toBeDefined();
    expect(entry.minTier).toBe("user");
  });

  it("只配智谱 + models.free：default 为宿主指定的免费模型，在目录内且标 user", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ slug: "glm-5.3" }, { slug: "glm-5.3-flash" }] }),
    }));
    const res = await handleChatModels(req("GET"), ctxWith({ zhipu: { apiKey: "k" } }, ["glm-5.3-flash"]));
    const body = await json(res);
    expect(body.default).toBe("glm-5.3-flash");
    expect(body.models.find((m: any) => m.id === body.default).minTier).toBe("user");
    expect(body.models.find((m: any) => m.id === "glm-5.3").minTier).toBe("pro");
  });

  it("OpenAI 拉取失败的降级目录同样带 default 且指向目录内", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    const res = await handleChatModels(req("GET"), openaiOnly);
    const body = await json(res);
    expect(body.models.map((m: any) => m.id)).toContain(body.default);
  });
});
