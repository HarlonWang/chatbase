import { describe, it, expect, vi } from "vitest";
import { handleGeneratedImage } from "../../src/handlers/generated-image.js";
import type { ChatContext } from "../../src/config.js";

const KEY = "0f96c2cd-f61f-4208-86aa-38523fb54870.jpg";
const get = (key: string) => new Request(`https://api.trendingai.cn/api/chat/generated-images/${key}`);
const ctxWith = (images: unknown) => ({ images }) as ChatContext;

describe("GET /api/chat/generated-images/:key", () => {
  it("命中 → 回吐 R2 对象，长缓存 + CORS", async () => {
    const images = { get: vi.fn(async () => ({ body: "bytes", httpMetadata: { contentType: "image/jpeg" } })) };
    const res = await handleGeneratedImage(get(KEY), ctxWith(images), KEY);
    expect(res.status).toBe(200);
    expect(images.get).toHaveBeenCalledWith(KEY);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("Cache-Control")).toContain("immutable");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("key 形状不对 → 404 且不查 R2（不给枚举/路径穿越留口）", async () => {
    const images = { get: vi.fn() };
    for (const bad of ["../x.jpg", "abc.jpg", `${KEY}.png`, "x".repeat(40)]) {
      const res = await handleGeneratedImage(get(bad), ctxWith(images), bad);
      expect(res.status).toBe(404);
    }
    expect(images.get).not.toHaveBeenCalled();
  });

  it("R2 无此对象 → 404", async () => {
    const images = { get: vi.fn(async () => null) };
    expect((await handleGeneratedImage(get(KEY), ctxWith(images), KEY)).status).toBe(404);
  });

  it("images 未配置 → 404", async () => {
    expect((await handleGeneratedImage(get(KEY), ctxWith(null), KEY)).status).toBe(404);
  });

  it("非 GET → 405", async () => {
    const res = await handleGeneratedImage(new Request("https://api.trendingai.cn/x", { method: "POST" }), {} as ChatContext, KEY);
    expect(res.status).toBe(405);
  });
});
