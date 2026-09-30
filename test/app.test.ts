import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { createChat } from "../src/index.js";
import { clearModelsCache } from "../src/models.js";
import { renderItemContext } from "../src/chat/input.js";
import type { ChatConfig, TierInfo } from "../src/config.js";
import { makeDB, fakeR2, openaiJson, sseUpstream, textStreamLines, parseFrames, json } from "./handlers/helpers.js";

// 宿主 env 形状由宿主自定；这里模拟一个裸 Worker 的 env
interface HostEnv {
  DB: ReturnType<typeof makeDB>;
  IMAGES: ReturnType<typeof fakeR2>;
  KEY: string;
  tier: TierInfo;
}

const KEY = "0f96c2cd-f61f-4208-86aa-38523fb54870.jpg";
const ORIGIN = "https://api.trendingai.cn";
const USER_MSG = [{ role: "user", content: "hi" }];

const makeEnv = (over: Partial<HostEnv> = {}): HostEnv => ({
  DB: makeDB({ balance: 5, userIdentity: { balance: 90, last_grant_tier: "pro" } }),
  IMAGES: fakeR2(),
  KEY: "sk-test",
  tier: { tier: "anonymous" },
  ...over,
});

const resolve = vi.fn((env: HostEnv): ChatConfig => ({
  db: env.DB as unknown as D1Database,
  images: env.IMAGES as unknown as R2Bucket,
  providers: { openai: { apiKey: env.KEY } },
  resolveTier: () => env.tier,
  prompt: { brand: "TrendingAI", context: renderItemContext },
}));

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Install-Id": "dev-1", ...headers },
    body: JSON.stringify(body),
  });
const get = (path: string, headers: Record<string, string> = { "X-Install-Id": "dev-1" }) =>
  new Request(`${ORIGIN}${path}`, { headers });

const stubJson = (content = "ok") =>
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => openaiJson(content) }));

beforeEach(() => { resolve.mockClear(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); clearModelsCache(); });

describe("createChat：路由分发（默认 basePath=/api）", () => {
  const chat = createChat(resolve);
  const exec = () => ({ waitUntil: vi.fn() }) as unknown as ExecutionContext;

  it("POST /api/chat → handleChat（JSON 模式）", async () => {
    stubJson("hello");
    const res = await chat.fetch(post("/api/chat", { messages: USER_MSG }), makeEnv(), exec());
    expect(res.status).toBe(200);
    expect((await json(res)).content).toBe("hello");
  });

  it("POST /api/chat stream:true → SSE 帧协议不变", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseUpstream(textStreamLines(["a", "b"]))));
    const res = await chat.fetch(post("/api/chat", { messages: USER_MSG, stream: true }), makeEnv(), exec());
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const evs = parseFrames(await res.text());
    expect(evs.map((e) => e.delta).filter(Boolean).join("")).toBe("ab");
    expect(evs.at(-1)).toEqual({ done: true });
  });

  it("GET /api/chat/models → 目录", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: "gpt-5.6-sol" }] }) }));
    const res = await chat.fetch(get("/api/chat/models", {}), makeEnv());
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.models.map((m: any) => m.id)).toContain(body.default);
  });

  it("POST /api/chat/transcribe → handleChatTranscribe（匿名 403 voice_requires_pro）", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array(16)], "v.m4a"));
    form.append("duration_ms", "1000");
    const req = new Request(`${ORIGIN}/api/chat/transcribe`, { method: "POST", headers: { "X-Install-Id": "dev-1" }, body: form });
    const res = await chat.fetch(req, makeEnv(), exec());
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe("voice_requires_pro");
  });

  it("GET /api/chat/generated-images/:key → 回吐 R2 对象，key 取自路径参数", async () => {
    const env = makeEnv();
    env.IMAGES.get.mockResolvedValue({ body: "bytes", httpMetadata: { contentType: "image/jpeg" } } as never);
    const res = await chat.fetch(get(`/api/chat/generated-images/${KEY}`, {}), env);
    expect(res.status).toBe(200);
    expect(env.IMAGES.get).toHaveBeenCalledWith(KEY);
    expect(res.headers.get("Cache-Control")).toContain("immutable");
  });

  it("GET /api/quota → 余额", async () => {
    const res = await chat.fetch(get("/api/quota"), makeEnv());
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({ balance: 5, tier: "anonymous" });
  });

  it("未知路径 → 404 JSON not_found（带 CORS）", async () => {
    for (const path of ["/api/nope", "/api/chat/unknown", "/api/chat/generated-images/a/b", "/quota"]) {
      const res = await chat.fetch(get(path), makeEnv());
      expect(res.status).toBe(404);
      expect(await json(res)).toEqual({ success: false, error: "Not found", code: "not_found" });
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    }
  });

  it("OPTIONS 预检：五个路径都 200 + CORS 头", async () => {
    for (const path of ["/api/chat", "/api/chat/models", "/api/chat/transcribe", `/api/chat/generated-images/${KEY}`, "/api/quota"]) {
      const res = await chat.fetch(new Request(`${ORIGIN}${path}`, { method: "OPTIONS" }), makeEnv());
      expect(res.status).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(res.headers.get("Access-Control-Allow-Headers")).toContain("X-Install-Id");
    }
  });

  it("方法白名单在 handler 内：GET /api/chat → 405，POST /api/quota → 405", async () => {
    expect((await chat.fetch(get("/api/chat"), makeEnv())).status).toBe(405);
    expect((await chat.fetch(post("/api/quota", {}), makeEnv())).status).toBe(405);
  });

  it("不传 ExecutionContext 也能跑（非 Workers 宿主 / 测试）", async () => {
    stubJson("no exec");
    const res = await chat.fetch(post("/api/chat", { messages: USER_MSG }), makeEnv());
    expect(res.status).toBe(200);
    expect((await json(res)).content).toBe("no exec");
  });

  it("ExecutionContext.waitUntil 收到留痕与 SSE 后台续读", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseUpstream(textStreamLines(["x"]))));
    const ec = exec();
    const res = await chat.fetch(post("/api/chat", { messages: USER_MSG, stream: true }), makeEnv(), ec);
    await res.text();
    expect((ec.waitUntil as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("createChat：basePath 可配", () => {
  it("basePath=/v1 → 端点挂在 /v1 下，/api 下 404", async () => {
    const chat = createChat(resolve, { basePath: "/v1" });
    stubJson("v1 ok");
    const ok = await chat.fetch(post("/v1/chat", { messages: USER_MSG }), makeEnv());
    expect(ok.status).toBe(200);
    expect((await json(ok)).content).toBe("v1 ok");
    expect((await chat.fetch(get("/v1/quota"), makeEnv())).status).toBe(200);
    expect((await chat.fetch(get("/api/quota"), makeEnv())).status).toBe(404);
    expect((await chat.fetch(post("/api/chat", { messages: USER_MSG }), makeEnv())).status).toBe(404);
  });

  it("basePath=/v1 → 生成图 URL 以 /v1 为前缀", async () => {
    const chat = createChat(resolve, { basePath: "/v1" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseUpstream([
      "{\"type\":\"response.output_item.done\",\"item\":{\"type\":\"image_generation_call\",\"status\":\"completed\",\"result\":\"aGVsbG8=\"}}",
      "{\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":5,\"output_tokens\":2}}}",
    ])));
    const env = makeEnv({ tier: { tier: "pro", userSub: "p-1" } });
    const res = await chat.fetch(post("/v1/chat", { messages: USER_MSG, stream: true, imageGeneration: true }), env);
    const evs = parseFrames(await res.text());
    const md = evs.find((e) => typeof e.delta === "string" && e.delta.includes("!["))!.delta as string;
    expect(md).toMatch(new RegExp(`^\\n\\n!\\[\\]\\(${ORIGIN}/v1/chat/generated-images/[0-9a-f-]{36}\\.jpg\\)\\n\\n$`));
    expect(chat.context(env).basePath).toBe("/v1");
  });
});

describe("createChat：上下文与档位裁决", () => {
  it("同一 env 引用只 resolve 一次（memoize），不同 env 各自解析", async () => {
    const chat = createChat(resolve);
    const a = makeEnv();
    const b = makeEnv();
    await chat.fetch(get("/api/quota"), a);
    await chat.fetch(get("/api/quota"), a);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(chat.context(a)).toBe(chat.context(a));
    await chat.fetch(get("/api/quota"), b);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(chat.context(b)).not.toBe(chat.context(a));
  });

  it("宿主 resolveTier 决定档位：pro → /quota 报 pro 档", async () => {
    const chat = createChat(resolve);
    const res = await chat.fetch(get("/api/quota"), makeEnv({ tier: { tier: "pro", userSub: "p-1" } }));
    expect(await json(res)).toMatchObject({ tier: "pro", balance: 90 });
  });

  it("宿主 resolveTier 报 authInvalid → 401 auth_invalid（chat 与 quota 一致）", async () => {
    const chat = createChat(resolve);
    const env = makeEnv({ tier: { authInvalid: true } });
    const q = await chat.fetch(get("/api/quota"), env);
    expect(q.status).toBe(401);
    expect((await json(q)).code).toBe("auth_invalid");
    const c = await chat.fetch(post("/api/chat", { messages: USER_MSG }), env);
    expect(c.status).toBe(401);
  });

  it("reclaim(env) 走同一上下文回收孤儿 pending", async () => {
    const chat = createChat(resolve);
    const env = makeEnv();
    const out = await chat.reclaim(env);
    expect(out).toEqual({ scanned: 0, reclaimed: 0, refunded: 0 });
    expect(env.DB.prepare.mock.calls.some(([sql]) => sql.includes("status = 'pending'"))).toBe(true);
  });

  it("app 可作为 Hono 子应用挂到宿主上", async () => {
    const { Hono } = await import("hono");
    const chat = createChat(resolve);
    const host = new Hono<{ Bindings: HostEnv }>();
    host.get("/health", (c) => c.text("ok"));
    host.route("/", chat.app);
    expect(await (await host.fetch(new Request(`${ORIGIN}/health`), makeEnv())).text()).toBe("ok");
    const res = await host.fetch(get("/api/quota"), makeEnv());
    expect(res.status).toBe(200);
    expect((await json(res)).tier).toBe("anonymous");
  });
});
