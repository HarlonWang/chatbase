import { describe, it, expect } from "vitest";
import { decideChatPolicy, MAX_TOKENS, type ChatPolicy } from "../../src/chat/policy.js";
import { DEFAULT_MODEL } from "../../src/models.js";
import type { ChatRequest } from "../../src/chat/request.js";
import type { Tier } from "../../src/config.js";

const base: ChatRequest = {
  messages: [{ role: "user", content: "q" }], lastText: "q", lang: "en", context: null,
  imageCount: 0, wantSearch: false, wantImageGeneration: false, wantStream: true, requestedModel: undefined,
};
const ok = (p: ReturnType<typeof decideChatPolicy>): ChatPolicy => {
  if (p.error) throw new Error(`unexpected deny: ${p.error.code}`);
  return p;
};

describe("decideChatPolicy：档位 × 模型 × 能力 × 开关（表驱动）", () => {
  it.each<[string, Partial<ChatRequest>, Tier, number, string]>([
    ["匿名带图", { imageCount: 1 }, "anonymous", 403, "images_require_login"],
    ["免费用户开生图", { wantImageGeneration: true }, "user", 403, "image_generation_requires_pro"],
    ["匿名开搜索", { wantSearch: true }, "anonymous", 403, "search_requires_pro"],
    ["免费用户开搜索", { wantSearch: true }, "user", 403, "search_requires_pro"],
    ["Pro 生图但非流式", { wantImageGeneration: true, wantStream: false }, "pro", 400, "image_generation_requires_stream"],
    ["Pro 选 DeepSeek V4 Pro 带图（模型不识图）", { imageCount: 1, requestedModel: "deepseek-v4-pro" }, "pro", 400, "images_unsupported"],
    ["Pro 选 DeepSeek 开搜索", { wantSearch: true, requestedModel: "deepseek-v4-flash" }, "pro", 400, "search_unsupported"],
    ["Pro 选 DeepSeek 开生图", { wantImageGeneration: true, requestedModel: "deepseek-v4-flash" }, "pro", 400, "image_generation_unsupported"],
  ])("%s → %i %s", (_n, over, tier, status, code) => {
    expect(decideChatPolicy({ ...base, ...over }, tier).error).toMatchObject({ status, code });
  });

  it("先档位后能力：免费用户 + DeepSeek + 生图 → 先报「要 Pro」不是「模型不支持」", () => {
    // 非 Pro 请求 DeepSeek 会被降级回默认模型，随后生图规则按档位先拦
    expect(decideChatPolicy({ ...base, wantImageGeneration: true, requestedModel: "deepseek-v4-flash" }, "user").error!.code).toBe("image_generation_requires_pro");
    expect(decideChatPolicy({ ...base, wantSearch: true, requestedModel: "deepseek-v4-flash" }, "user").error!.code).toBe("search_requires_pro");
  });

  it("普通对话：默认模型、feature=chat、不挂工具、无额外预估成本", () => {
    const p = ok(decideChatPolicy(base, "anonymous"));
    expect(p.model).toBe(DEFAULT_MODEL);
    expect(p.feature).toBe("chat");
    expect(p.extraCostMicros).toBe(0);
    expect(p.upstream).toEqual({ model: DEFAULT_MODEL, maxTokens: MAX_TOKENS, stream: true, retry: 1 });
  });

  it("Pro 搜索：feature=chat_search，挂 web_search，max_tool_calls=3", () => {
    const p = ok(decideChatPolicy({ ...base, wantSearch: true }, "pro"));
    expect(p.feature).toBe("chat_search");
    expect(p.upstream.tools).toEqual([{ type: "web_search", search_context_size: "medium" }]);
    expect(p.upstream.maxToolCalls).toBe(3);
  });

  it("Pro 生图：feature=chat_image_generation，工具来自厂商注册表，1 张封顶，按张费进熔断预估", () => {
    const p = ok(decideChatPolicy({ ...base, wantImageGeneration: true }, "pro"));
    expect(p.feature).toBe("chat_image_generation");
    expect((p.upstream.tools![0] as any).type).toBe("image_generation");
    expect(p.upstream.maxToolCalls).toBe(1);
    expect(p.extraCostMicros).toBe(p.provider.imageGenerationCallMicros);
  });

  it("非 Pro 请求付费模型被降回默认；Pro 可切", () => {
    expect(ok(decideChatPolicy({ ...base, requestedModel: "gpt-5.6-sol" }, "user")).model).toBe(DEFAULT_MODEL);
    expect(ok(decideChatPolicy({ ...base, requestedModel: "gpt-5.6-sol" }, "pro")).model).toBe("gpt-5.6-sol");
  });

  it("imagesEnabled=false：Pro 开生图 → 400 image_generation_unsupported；档位规则仍先于它", () => {
    expect(decideChatPolicy({ ...base, wantImageGeneration: true }, "pro", { imagesEnabled: false }).error).toMatchObject({ status: 400, code: "image_generation_unsupported" });
    expect(decideChatPolicy({ ...base, wantImageGeneration: true }, "user", { imagesEnabled: false }).error!.code).toBe("image_generation_requires_pro");
    // 不开生图时该开关无影响
    expect(ok(decideChatPolicy(base, "pro", { imagesEnabled: false })).feature).toBe("chat");
  });
});
