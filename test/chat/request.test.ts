import { describe, it, expect } from "vitest";
import { parseChatRequest, MAX_CONTENT_LEN, MAX_IMAGE_B64 } from "../../src/chat/request.js";

const IMG = "data:image/jpeg;base64," + "A".repeat(100);
const cfg = { maxCount: 2, maxTotalImageB64: 1000 };
const user = (content: unknown) => ({ role: "user", content });
const bot = (content: unknown) => ({ role: "assistant", content });

describe("parseChatRequest：形态校验（表驱动）", () => {
  it.each<[string, unknown, string]>([
    ["messages 缺失", {}, "invalid_request"],
    ["messages 空", { messages: [] }, "invalid_request"],
    ["role 非法", { messages: [{ role: "system", content: "x" }] }, "invalid_message_format"],
    ["assistant 不许 parts", { messages: [bot([{ type: "text", text: "x" }]), user("q")] }, "invalid_message_format"],
    ["parts 未知 type", { messages: [user([{ type: "file", x: 1 }])] }, "invalid_message_format"],
    ["http 图片 URL 拒绝", { messages: [user([{ type: "image_url", image_url: { url: "https://x/a.png" } }])] }, "invalid_message_format"],
    ["空 parts", { messages: [user([])] }, "invalid_message_format"],
    ["user 超长", { messages: [user("x".repeat(MAX_CONTENT_LEN + 1))] }, "content_too_long"],
    ["末条非 user", { messages: [user("q"), bot("a")] }, "last_must_be_user"],
    ["图片在历史", { messages: [user([{ type: "image_url", image_url: { url: IMG } }]), bot("a"), user("q")] }, "images_in_history"],
    ["张数超限", { messages: [user([{ type: "image_url", image_url: { url: IMG } }, { type: "image_url", image_url: { url: IMG } }, { type: "image_url", image_url: { url: IMG } }])] }, "too_many_images"],
    ["单张超限", { messages: [user([{ type: "image_url", image_url: { url: "data:image/png;base64," + "A".repeat(MAX_IMAGE_B64) } }])] }, "image_too_large"],
  ])("%s → %s", (_name, body, code) => {
    const r = parseChatRequest(body, cfg);
    expect(r.error).toMatchObject({ status: 400, code });
  });

  it("总量超限 → images_too_large（单张未超、合计超 maxTotalImageB64）", () => {
    const big = "data:image/webp;base64," + "A".repeat(600);
    const r = parseChatRequest({ messages: [user([{ type: "image_url", image_url: { url: big } }, { type: "image_url", image_url: { url: big } }])] }, cfg);
    expect(r.error?.code).toBe("images_too_large");
  });

  it("assistant 历史超 4000 不拒（豁免）", () => {
    const r = parseChatRequest({ messages: [bot("x".repeat(9000)), user("q")] }, cfg);
    expect(r.error).toBeUndefined();
  });

  it("归一化：lang 只认 zh、search 被 imageGeneration 压掉、lastText / imageCount 取末条", () => {
    const r = parseChatRequest({
      messages: [bot("a"), user([{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: IMG } }])],
      lang: "zh", search: true, imageGeneration: true, stream: true, model: "gpt-5.6-sol", context: { title: "t" },
    }, cfg);
    expect(r).toMatchObject({ lang: "zh", wantSearch: false, wantImageGeneration: true, wantStream: true, lastText: "hi", imageCount: 1, requestedModel: "gpt-5.6-sol", context: { title: "t" } });
    const ja = parseChatRequest({ messages: [user("q")], lang: "ja" }, cfg);
    expect(ja.error).toBeUndefined();
    expect(ja.error === undefined && ja.lang).toBe("en");
  });
});
