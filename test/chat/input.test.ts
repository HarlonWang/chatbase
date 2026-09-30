import { describe, it, expect } from "vitest";
import { buildChatInput, buildSystemPrompt, renderItemContext, trimHistory } from "../../src/chat/input.js";
import type { ChatMessage, ChatRequest, ContentPart } from "../../src/chat/request.js";
import type { PromptConfig } from "../../src/config.js";

const ORIGIN = "https://api.trendingai.cn";
const prompt: PromptConfig = { brand: "TrendingAI", context: renderItemContext };
const user = (content: string | ContentPart[]): ChatMessage => ({ role: "user", content });
const bot = (content: string): ChatMessage => ({ role: "assistant", content });
const req = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  messages: [user("q")], lastText: "q", lang: "en", context: null, requestedModel: undefined, wantStream: false,
  imageCount: 0, wantImageGeneration: false, wantSearch: false, ...over,
});
const contentOf = (input: ReturnType<typeof buildChatInput>) => input[input.length - 1].content;

describe("buildSystemPrompt", () => {
  it("语言 / 生图开关 / 上下文 / 搜索指引按顺序拼接", () => {
    const s = buildSystemPrompt(prompt, "zh", { title: "T", summary: "S", sourceUrl: "https://u" }, { imageGeneration: true, search: true });
    expect(s.indexOf("image_generation 工具")).toBeGreaterThan(0);
    expect(s.indexOf("标题: T")).toBeGreaterThan(s.indexOf("image_generation 工具"));
    expect(s.indexOf("检索到网络信息时")).toBeGreaterThan(s.indexOf("请优先基于该条目作答"));
    expect(buildSystemPrompt(prompt, "en", null).startsWith("You are TrendingAI's AI assistant")).toBe(true);
    expect(buildSystemPrompt(prompt, "en", null)).toContain("cannot generate, draw, or edit images");
  });

  it("brand 注入首句（中英）", () => {
    const tono: PromptConfig = { brand: "Tono" };
    expect(buildSystemPrompt(tono, "en", null).startsWith("You are Tono's AI assistant")).toBe(true);
    expect(buildSystemPrompt(tono, "zh", null).startsWith("你是 Tono 的 AI 助手")).toBe(true);
  });

  it("未提供 context 渲染函数时忽略请求体 context", () => {
    const s = buildSystemPrompt({ brand: "Tono" }, "zh", { title: "ITEM_TITLE", summary: "ITEM_SUMMARY" });
    expect(s).not.toContain("ITEM_TITLE");
    expect(s).not.toContain("用户正在查看以下条目");
  });

  it("system 函数给了时整段覆盖，brand / context / 搜索指引均不再拼接", () => {
    const custom: PromptConfig = {
      brand: "Tono",
      context: renderItemContext,
      system: (lang, flags) => `custom:${lang}:${flags.imageGeneration}:${flags.search}`,
    };
    const s = buildSystemPrompt(custom, "zh", { title: "T" }, { imageGeneration: true, search: true });
    expect(s).toBe("custom:zh:true:true");
  });
});

describe("trimHistory", () => {
  it("最多 12 条；超 16k 字符从最旧丢；末条永远保留", () => {
    const many = Array.from({ length: 20 }, (_, i) => (i % 2 ? bot(`a${i}`) : user(`q${i}`)));
    expect(trimHistory(many)).toHaveLength(12);
    const heavy = [bot("x".repeat(9000)), user("y".repeat(9000)), user("last")];
    const t = trimHistory(heavy);
    expect(t.map((m) => (m.content as string).slice(0, 4))).toEqual(["yyyy", "last"]);
    expect(trimHistory([user("x".repeat(20000))])).toHaveLength(1);
  });
});

describe("buildChatInput", () => {
  it("system 在前，历史原样透传", () => {
    const input = buildChatInput(prompt, req({ messages: [bot("a"), user("q")] }), ORIGIN);
    expect(input[0].role).toBe("system");
    expect(input.slice(1)).toEqual([{ role: "assistant", content: "a" }, { role: "user", content: "q" }]);
  });

  it("生图跟进：末条无图时把历史里最近一张本服务生成的图作为参考图追加到末条", () => {
    const ours = `${ORIGIN}/api/chat/generated-images/123e4567-e89b-12d3-a456-426614174000.jpg`;
    const messages = [user("画一只猫"), bot(`![](${ours})`), bot("![](https://evil.example/x.jpg)"), user("换个背景")];
    const input = buildChatInput(prompt, req({ messages, wantImageGeneration: true }), ORIGIN);
    expect(contentOf(input)).toEqual([{ type: "text", text: "换个背景" }, { type: "image_url", image_url: { url: ours } }]);
  });

  it("生图跟进：外链图片不认；末条已带图不再追加；未开生图不追加", () => {
    const foreign = [bot("![](https://evil.example/x.jpg)"), user("换个背景")];
    expect(contentOf(buildChatInput(prompt, req({ messages: foreign, wantImageGeneration: true }), ORIGIN))).toBe("换个背景");
    const ours = `${ORIGIN}/api/chat/generated-images/123e4567-e89b-12d3-a456-426614174000.jpg`;
    const withImg = [bot(`![](${ours})`), user([{ type: "text", text: "x" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }])];
    expect(contentOf(buildChatInput(prompt, req({ messages: withImg, wantImageGeneration: true, imageCount: 1 }), ORIGIN))).toHaveLength(2);
    expect(contentOf(buildChatInput(prompt, req({ messages: [bot(`![](${ours})`), user("q")] }), ORIGIN))).toBe("q");
  });
});
