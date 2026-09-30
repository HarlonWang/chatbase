import { describe, it, expect, vi, afterEach } from "vitest";
import { handleChatTranscribe } from "../../src/handlers/transcribe.js";
import { makeCtx, tierInfo, EXEC, json, type TestCtx } from "./helpers.js";

// Pro 场景以 userIdentity 余额表达用量状态；last_grant_tier=pro 才不触发按档重授
const proCtx = ({ balance = 90, tier = tierInfo("pro", "pro-1"), kv }: { balance?: number; tier?: ReturnType<typeof tierInfo>; kv?: unknown } = {}) =>
  makeCtx({ db: { userIdentity: { balance, last_grant_tier: "pro" } }, tier, kv });

const AUDIO = new Uint8Array(1024);

const makePost = ({ file = new File([AUDIO], "voice.m4a", { type: "audio/mp4" }) as File | null, durationMs = 5000 as number | null, lang = "zh", installId = "dev-1" as string | null } = {}) => {
  const form = new FormData();
  if (file) form.append("file", file);
  if (durationMs != null) form.append("duration_ms", String(durationMs));
  form.append("lang", lang);
  return new Request("https://api.trendingai.cn/api/chat/transcribe", {
    method: "POST",
    headers: installId ? { "X-Install-Id": installId } : {},
    body: form,
  });
};

// fetch 全部当作转写上游
const stubFetch = ({ transcription = { text: " 你好 世界 ", languages: [{ code: "zh-cn" }], usage: { type: "duration", seconds: 4.2 } } as any, upstreamStatus = 200 } = {}) => {
  const fetchMock = vi.fn(async () => {
    if (upstreamStatus !== 200) return { ok: false, status: upstreamStatus, text: async () => "boom" };
    return { ok: true, json: async () => transcription };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

// 按 SQL 片段找 statement 的绑定参数（无绑定的语句不会进 db 级 bind，序号法会错位）
const stmtBinds = (ctx: TestCtx, fragment: string): any[] =>
  ctx.db.prepare.mock.results.find((r) => r.value.sql.includes(fragment))!.value.bind.mock.calls[0];

const upstreamCall = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.find(([url]: any[]) => String(url).includes("/audio/transcriptions")) as [string, any] | undefined;

const call = (req: Request, ctx: TestCtx) => handleChatTranscribe(req, ctx, EXEC());

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("handleChatTranscribe", () => {
  it("Pro 用户 → 转发 gpt-transcribe，返回修剪后的文本与语言", async () => {
    const fetchMock = stubFetch();
    const res = await call(makePost(), proCtx());
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ text: "你好 世界", languages: ["zh-cn"] });

    const [, opts] = upstreamCall(fetchMock)!;
    expect(opts.method).toBe("POST");
    expect(opts.body).toBeInstanceOf(FormData);
    expect(opts.body.get("model")).toBe("gpt-transcribe");
    expect(opts.body.getAll("languages[]")).toEqual(["zh-cn", "en"]);
    expect(opts.body.get("file")).toBeInstanceOf(Blob);
    // multipart 的 Content-Type 交给运行时按 boundary 生成，手写会丢 boundary
    expect(opts.headers["Content-Type"]).toBeUndefined();
  });

  it("lang=en → 英文为主提示、中文兜底", async () => {
    const fetchMock = stubFetch();
    await call(makePost({ lang: "en" }), proCtx());
    expect(upstreamCall(fetchMock)![1].body.getAll("languages[]")).toEqual(["en", "zh-cn"]);
  });

  it("成本按上游秒数折算（$0.0045/min = 75μ$/s），账本记 chat_voice", async () => {
    stubFetch();
    const ctx = proCtx();
    await call(makePost({ durationMs: 60000 }), ctx);
    const binds = stmtBinds(ctx, "UPDATE usage_events SET status = 'ok'");
    expect(binds[0]).toBe("gpt-transcribe");
    expect(binds[3]).toBe(Math.ceil(4.2 * 75));
    expect(stmtBinds(ctx, "INSERT INTO usage_events")[2]).toBe("chat_voice");
  });

  it("上游 usage 为 tokens 型 → tokens 进账本，成本回落客户端时长", async () => {
    stubFetch({ transcription: { text: "hi", usage: { type: "tokens", input_tokens: 14, output_tokens: 3 } } });
    const ctx = proCtx();
    await call(makePost({ durationMs: 10000 }), ctx);
    expect(stmtBinds(ctx, "UPDATE usage_events SET status = 'ok'").slice(1, 4)).toEqual([14, 3, 10 * 75]);
  });

  it("匿名 → 403 voice_requires_pro", async () => {
    stubFetch();
    const res = await call(makePost(), makeCtx());
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe("voice_requires_pro");
  });

  it("登录非 Pro → 403 voice_requires_pro，且不打上游", async () => {
    const fetchMock = stubFetch();
    const res = await call(makePost(), proCtx({ tier: tierInfo("user", "u-1") }));
    expect(res.status).toBe(403);
    expect(upstreamCall(fetchMock)).toBeUndefined();
  });

  it("宿主判定 authInvalid → 401 auth_invalid", async () => {
    stubFetch();
    const res = await call(makePost(), makeCtx({ tier: { authInvalid: true } }));
    expect(res.status).toBe(401);
    expect((await json(res)).code).toBe("auth_invalid");
  });

  it("resolveTier 抛错 → 500 internal", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch();
    const ctx = makeCtx();
    ctx.resolveTier.mockRejectedValue(new Error("boom"));
    const res = await call(makePost(), ctx);
    expect(res.status).toBe(500);
    expect((await json(res)).code).toBe("internal");
  });

  it("缺 install id → 400", async () => {
    const res = await call(makePost({ installId: null }), proCtx());
    expect(res.status).toBe(400);
  });

  it("非 multipart 请求体 → 400 invalid_request", async () => {
    const req = new Request("https://api.trendingai.cn/api/chat/transcribe", {
      method: "POST",
      headers: { "X-Install-Id": "dev-1", "Content-Type": "application/json" },
      body: "{}",
    });
    const res = await call(req, proCtx());
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe("invalid_request");
  });

  it("无文件 / 空文件 → 400 audio_empty", async () => {
    const res = await call(makePost({ file: null }), proCtx());
    expect((await json(res)).code).toBe("audio_empty");
    const res2 = await call(makePost({ file: new File([], "v.m4a") }), proCtx());
    expect((await json(res2)).code).toBe("audio_empty");
  });

  it("缺 duration_ms → 400 invalid_request", async () => {
    const res = await call(makePost({ durationMs: null }), proCtx());
    expect((await json(res)).code).toBe("invalid_request");
  });

  it("超体积 → 400 audio_too_large（校验在鉴权之前，不烧鉴权与上游）", async () => {
    const fetchMock = stubFetch();
    const big = new File([new Uint8Array(2 * 1024 * 1024 + 1)], "v.m4a");
    const ctx = proCtx();
    const res = await call(makePost({ file: big }), ctx);
    expect((await json(res)).code).toBe("audio_too_large");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx.resolveTier).not.toHaveBeenCalled();
  });

  it("超时长 → 400 audio_too_long；KV 收紧上限即时生效", async () => {
    stubFetch();
    const ctx = proCtx({ kv: { get: async () => "{\"max_duration_ms\":30000}" } });
    const res = await call(makePost({ durationMs: 30001 }), ctx);
    expect((await json(res)).code).toBe("audio_too_long");
    const ok = await call(makePost({ durationMs: 30000 }), ctx);
    expect(ok.status).toBe(200);
  });

  it("上游失败 → 502 并退还预扣（账本 aborted）", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch({ upstreamStatus: 500 });
    const ctx = proCtx();
    const res = await call(makePost(), ctx);
    expect(res.status).toBe(502);
    expect((await json(res)).code).toBe("upstream_error");
    const aborted = ctx.db.calls.sql.find((s) => s.includes("status = 'aborted'"));
    expect(aborted).toBeDefined();
    expect(ctx.db.batch).toHaveBeenCalled();
  });

  it("Pro 余额耗尽 → 429 tier=pro", async () => {
    stubFetch();
    const res = await call(makePost(), proCtx({ balance: 0 }));
    expect(res.status).toBe(429);
    expect((await json(res)).tier).toBe("pro");
  });

  it("GET → 405；OPTIONS → CORS 预检", async () => {
    const get = await call(new Request("https://x/api/chat/transcribe"), proCtx());
    expect(get.status).toBe(405);
    const opt = await call(new Request("https://x/api/chat/transcribe", { method: "OPTIONS" }), proCtx());
    expect(opt.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
