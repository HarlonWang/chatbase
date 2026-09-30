import { describe, it, expect, vi, afterEach } from "vitest";
import { handleChat } from "../../src/handlers/chat.js";
import { MAX_CONTENT_LEN } from "../../src/chat/request.js";
import {
  makeCtx, makeDB, tierInfo, fakeR2, EXEC, findBound, hasSql, openaiJson, stubFetchOk,
  sseUpstream, textStreamLines, parseFrames, json, type TestCtx, type MakeCtxOpts,
} from "./helpers.js";

const URL_CHAT = "https://api.trendingai.cn/api/chat";

const makePost = (body: unknown, { installId = "dev-1" as string | null } = {}) =>
  new Request(URL_CHAT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(installId ? { "X-Install-Id": installId } : {}),
    },
    body: JSON.stringify(body),
  });

const USER_MSG = [{ role: "user", content: "hi" }];

const call = (req: Request, ctx: TestCtx) => handleChat(req, ctx, EXEC());

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Chat API error codes", () => {
  it("OPTIONS 预检返回 200", async () => {
    const req = new Request(URL_CHAT, { method: "OPTIONS" });
    const res = await call(req, makeCtx());
    expect(res.status).toBe(200);
  });

  it("非 POST → 405 method_not_allowed", async () => {
    const req = new Request(URL_CHAT, { method: "GET" });
    const res = await call(req, makeCtx());
    expect(res.status).toBe(405);
    expect((await json(res)).code).toBe("method_not_allowed");
  });

  it("缺 install id → 400 missing_install_id", async () => {
    const res = await call(makePost({ messages: USER_MSG }, { installId: null }), makeCtx());
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe("missing_install_id");
  });

  it("body 非 JSON → 400 invalid_json", async () => {
    const req = new Request(URL_CHAT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Install-Id": "dev-1" },
      body: "not-json",
    });
    const res = await call(req, makeCtx());
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe("invalid_json");
  });

  it("messages 缺失 → 400 invalid_request", async () => {
    const res = await call(makePost({}), makeCtx());
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe("invalid_request");
  });

  it("消息结构非法 → 400 invalid_message_format", async () => {
    const res = await call(makePost({ messages: [{ role: "user", content: 123 }] }), makeCtx());
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe("invalid_message_format");
  });

  it("user 消息超上限 → 400 content_too_long", async () => {
    const res = await call(
      makePost({ messages: [{ role: "user", content: "x".repeat(MAX_CONTENT_LEN + 1) }] }),
      makeCtx(),
    );
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe("content_too_long");
  });

  it("历史里 assistant 回复超上限不应被拒（豁免该闸），正常进入后续流程", async () => {
    stubFetchOk("ok");
    const res = await call(
      makePost({
        messages: [
          { role: "assistant", content: "x".repeat(MAX_CONTENT_LEN + 1) },
          { role: "user", content: "hi" },
        ],
      }),
      makeCtx(),
    );
    expect(res.status).toBe(200);
  });

  it("末条非 user → 400 last_must_be_user", async () => {
    const res = await call(
      makePost({ messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "ok" }] }),
      makeCtx(),
    );
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe("last_must_be_user");
  });

  it("余额用尽 → 429 quota_device，带次日重置时间 resetAt", async () => {
    const res = await call(makePost({ messages: USER_MSG }), makeCtx({ db: { balance: 0 } }));
    expect(res.status).toBe(429);
    const body = await json(res);
    expect(body.code).toBe("quota_device");
    expect(body.resetAt).toMatch(/T00:00:00\.000Z$/);
  });

  it("全局池真实成本达预算 → 429 quota_global，带 resetAt", async () => {
    const res = await call(makePost({ messages: USER_MSG }), makeCtx({ db: { globalCostMicros: 2_000_000 } }));
    expect(res.status).toBe(429);
    const body = await json(res);
    expect(body.code).toBe("quota_global");
    expect(body.resetAt).toMatch(/T00:00:00\.000Z$/);
  });

  it("上游超时 → 502 upstream_timeout，且 error 不含 OpenAI", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" })));
    const res = await call(makePost({ messages: USER_MSG }), makeCtx());
    expect(res.status).toBe(502);
    const body = await json(res);
    expect(body.code).toBe("upstream_timeout");
    expect(body.error).not.toMatch(/openai/i);
  });

  it("上游其它错误 → 502 upstream_error，且 error 不含 OpenAI", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "boom" }));
    const res = await call(makePost({ messages: USER_MSG }), makeCtx());
    expect(res.status).toBe(502);
    const body = await json(res);
    expect(body.code).toBe("upstream_error");
    expect(body.error).not.toMatch(/openai/i);
  });

  it("成功 → 200 返回 content", async () => {
    stubFetchOk("hi there");
    const res = await call(makePost({ messages: USER_MSG }), makeCtx());
    expect(res.status).toBe(200);
    expect((await json(res)).content).toBe("hi there");
  });

  it("上游失败 → 退还预扣并把 pending 行转 aborted（等价旧「成功才计数」，但并发不可超发）", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "boom" }));
    const ctx = makeCtx();
    const res = await call(makePost({ messages: USER_MSG }), ctx);
    expect(res.status).toBe(502);
    expect(hasSql(ctx.db, "balance = balance + ?")).toBe(true);
    // 预扣时先落 pending（与扣款同一 batch），失败后由条件 UPDATE 推向 aborted
    expect(ctx.db.prepare.mock.calls.some(([sql]) =>
      sql.includes("INSERT INTO usage_events") && sql.includes("'pending'"))).toBe(true);
    const abortSql = ctx.db.prepare.mock.calls
      .map(([sql]) => sql)
      .find((sql) => sql.includes("UPDATE usage_events") && sql.includes("status = 'aborted'"));
    expect(abortSql).toBeDefined();
    // 幂等锁：只有仍是 pending 的行会被认领，杜绝与回收 cron 竞争时重复退款
    expect(abortSql).toContain("status = 'pending'");
  });
});

describe("Chat API 配额分层（匿名/登录）", () => {
  const stubFetchRouted = ({ content = "ok" } = {}) =>
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => openaiJson(content) }));

  it("匿名触顶 → 429 quota_device，body 带 tier=anonymous", async () => {
    const res = await call(makePost({ messages: USER_MSG }), makeCtx({ db: { balance: 0 } }));
    expect(res.status).toBe(429);
    const body = await json(res);
    expect(body.code).toBe("quota_device");
    expect(body.tier).toBe("anonymous");
  });

  it("宿主判为 user → 身份切换为用户主体，设备余额耗尽不影响（登录升级重授 10）", async () => {
    stubFetchRouted();
    const ctx = makeCtx({ db: { balance: 0 }, tier: tierInfo("user", "u1") }); // 若仍按设备身份判断会 429；升级路径按 user 档重授
    const res = await call(makePost({ messages: USER_MSG }), ctx);
    expect(res.status).toBe(200);
    // 身份查询绑定宿主给的 userSub；扣量落 usage_events
    expect(findBound(ctx.db, "user_sub = ?")![0]).toBe("u1");
    expect(findBound(ctx.db, "INSERT INTO usage_events")).toBeTruthy();
  });

  it("登录用户余额耗尽 → 429 quota_device，tier=user", async () => {
    stubFetchRouted();
    const res = await call(
      makePost({ messages: USER_MSG }),
      makeCtx({ db: { userIdentity: { balance: 0 } }, tier: tierInfo("user", "u-2") }),
    );
    expect(res.status).toBe(429);
    const body = await json(res);
    expect(body.code).toBe("quota_device");
    expect(body.tier).toBe("user");
  });

  it("宿主判定 authInvalid → 401 auth_invalid，不静默降级（避免客户端误判为配额键已切换）", async () => {
    stubFetchRouted();
    const ctx = makeCtx({ tier: { authInvalid: true } });
    const res = await call(makePost({ messages: USER_MSG }), ctx);
    expect(res.status).toBe(401);
    expect((await json(res)).code).toBe("auth_invalid");
    expect(hasSql(ctx.db, "balance = balance - ?")).toBe(false);
  });

  it("resolveTier 抛错 → 500 internal，不降级放行、不预扣", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetchRouted();
    const ctx = makeCtx();
    ctx.resolveTier.mockRejectedValue(new Error("loginbase down"));
    const res = await call(makePost({ messages: USER_MSG }), ctx);
    expect(res.status).toBe(500);
    expect((await json(res)).code).toBe("internal");
    expect(hasSql(ctx.db, "balance = balance - ?")).toBe(false);
  });

  it("resolveTier 收到的是原始请求（宿主可读 Authorization）", async () => {
    stubFetchRouted();
    const ctx = makeCtx();
    const req = new Request(URL_CHAT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Install-Id": "dev-1", "Authorization": "Bearer tok" },
      body: JSON.stringify({ messages: USER_MSG }),
    });
    await call(req, ctx);
    expect(ctx.resolveTier).toHaveBeenCalledTimes(1);
    const seen = ctx.resolveTier.mock.calls[0][0] as Request;
    expect(seen.headers.get("Authorization")).toBe("Bearer tok");
  });

  it("匿名全局池按美元熔断，SQL 只统计 anonymous 档", async () => {
    const ctx = makeCtx({ db: { globalCostMicros: 2_000_000 } });
    const res = await call(makePost({ messages: USER_MSG }), ctx);
    expect(res.status).toBe(429);
    expect((await json(res)).code).toBe("quota_global");
    const globalSql = ctx.db.prepare.mock.calls.find(([sql]) => sql.includes("SUM"))![0];
    expect(globalSql).toContain("tier = 'anonymous'");
  });

  it("登录池独立预算：匿名池成本打满不影响登录用户，登录池 SQL 排除 anonymous", async () => {
    stubFetchRouted();
    const ctx = makeCtx({ db: { globalCostMicros: 2_000_000 }, tier: tierInfo("user", "u-3") }); // 2M < user 池 13M
    const res = await call(makePost({ messages: USER_MSG }), ctx);
    expect(res.status).toBe(200);
    const globalSql = ctx.db.prepare.mock.calls.find(([sql]) => sql.includes("SUM"))![0];
    expect(globalSql).toContain("tier <> 'anonymous'");
  });

  it("登录状态下 chat_logs 留痕仍记设备 install_id（问题维度不变）", async () => {
    stubFetchRouted();
    const ctx = makeCtx({ tier: tierInfo("user", "u-4") });
    await call(makePost({ messages: USER_MSG }), ctx);
    expect(findBound(ctx.db, "INSERT INTO chat_logs")![0]).toBe("dev-1");
  });

  it("配额拦截 → 调用宿主 onBlocked（quota_device / quota_global 各一次，带 tier 与 installId）", async () => {
    const device = makeCtx({ db: { balance: 0 } });
    await call(makePost({ messages: USER_MSG }), device);
    expect(device.onBlocked).toHaveBeenCalledTimes(1);
    expect(device.onBlocked.mock.calls[0][0]).toMatchObject({ reason: "quota_device", tier: "anonymous", feature: "chat", installId: "dev-1", userSub: null });

    const global = makeCtx({ db: { globalCostMicros: 2_000_000 } });
    await call(makePost({ messages: USER_MSG }), global);
    expect(global.onBlocked).toHaveBeenCalledTimes(1);
    expect(global.onBlocked.mock.calls[0][0]).toMatchObject({ reason: "quota_global", tier: "anonymous" });
  });
});

describe("Chat API Pro 档（额度 + 模型）", () => {
  // OpenAI 调用捕获 model
  const stubFetchPro = ({ modelCapture, content = "ok" }: { modelCapture?: string[]; content?: string } = {}) =>
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url: string, opts: any) => {
      if (opts && modelCapture) modelCapture.push(JSON.parse(opts.body).model);
      return { ok: true, json: async () => openaiJson(content) };
    }));

  // 账本 fake 直接复用：Pro 场景以 userIdentity 余额表达用量状态
  const proCtx = ({ isPro = true, balance = 90 } = {}) =>
    makeCtx({
      db: { userIdentity: { balance, last_grant_tier: isPro ? "pro" : "user" } },
      tier: tierInfo(isPro ? "pro" : "user", "pro-1"),
    });

  const post = (body: unknown) => makePost(body, { installId: "dev-pro" });

  it("Pro 额度抬到 100：余额 90（已用 10）仍可聊（user 档此时早已触顶）", async () => {
    stubFetchPro();
    const res = await call(post({ messages: USER_MSG }), proCtx({ isPro: true, balance: 90 }));
    expect(res.status).toBe(200);
  });

  it("Pro 余额耗尽 → 429，tier=pro", async () => {
    stubFetchPro();
    const res = await call(post({ messages: USER_MSG }), proCtx({ isPro: true, balance: 0 }));
    expect(res.status).toBe(429);
    expect((await json(res)).tier).toBe("pro");
  });

  it("Pro 请求 gpt-5.6-sol → 上游用 gpt-5.6-sol", async () => {
    const models: string[] = [];
    stubFetchPro({ modelCapture: models });
    const res = await call(post({ messages: USER_MSG, model: "gpt-5.6-sol" }), proCtx({ isPro: true }));
    expect(res.status).toBe(200);
    expect(models[0]).toBe("gpt-5.6-sol");
  });

  it("Pro 请求已退役的 gpt-5.4 → 上游回落到默认 gpt-5.6-luna", async () => {
    const models: string[] = [];
    stubFetchPro({ modelCapture: models });
    const res = await call(post({ messages: USER_MSG, model: "gpt-5.4" }), proCtx({ isPro: true }));
    expect(res.status).toBe(200);
    expect(models[0]).toBe("gpt-5.6-luna");
  });

  it("非 Pro 登录用户请求 gpt-5.5 → 被强制回默认 gpt-5.6-luna", async () => {
    const models: string[] = [];
    stubFetchPro({ modelCapture: models });
    const res = await call(post({ messages: USER_MSG, model: "gpt-5.5" }), proCtx({ isPro: false, balance: 5 }));
    expect(res.status).toBe(200);
    expect(models[0]).toBe("gpt-5.6-luna");
  });
});

describe("Chat API system prompt 能力边界", () => {
  const captureSystem = async (lang: string) => {
    const bodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url: string, opts: any) => {
      bodies.push(JSON.parse(opts.body));
      return { ok: true, json: async () => openaiJson("ok") };
    }));
    await call(makePost({ messages: USER_MSG, lang }), makeCtx());
    return bodies[0].input[0].content as string;
  };

  // 生图诉求要在第一句被明确拒绝（issue #48：赞助者登录、传图、再试三轮才发现做不了）
  it("zh：声明只识图、不生成，且不引导登录/上传再试", async () => {
    const system = await captureSystem("zh");
    expect(system).toContain("不能生成、绘制或修改图片");
    expect(system).toContain("第一句直接说明不支持");
    expect(system).toContain("不要建议用户登录或上传图片再试");
  });

  it("en：同一声明的英文版", async () => {
    const system = await captureSystem("en");
    expect(system).toContain("cannot generate, draw, or edit images");
    expect(system).toContain("say so plainly in your first sentence");
    expect(system).toContain("do not suggest signing in or uploading an image");
  });

  it("brand 与条目上下文来自宿主 prompt 配置（TrendingAI + renderItemContext）", async () => {
    const bodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url: string, opts: any) => {
      bodies.push(JSON.parse(opts.body));
      return { ok: true, json: async () => openaiJson("ok") };
    }));
    await call(makePost({ messages: USER_MSG, lang: "zh", context: { title: "owner/repo", summary: "S" } }), makeCtx());
    const system = bodies[0].input[0].content as string;
    expect(system.startsWith("你是 TrendingAI 的 AI 助手")).toBe(true);
    expect(system).toContain("用户正在查看以下条目");
    expect(system).toContain("标题: owner/repo");
  });
});

describe("Chat API 多模态图片消息", () => {
  const dataUrl = (len = 100, mime = "jpeg") => `data:image/${mime};base64,${"A".repeat(len)}`;
  const imagePart = (len = 100, mime = "jpeg") => ({ type: "image_url", image_url: { url: dataUrl(len, mime) } });
  const textPart = (text = "look") => ({ type: "text", text });

  // 捕获发往 OpenAI 的请求体
  const stubFetchAuthed = ({ content = "ok", bodyCapture }: { content?: string; bodyCapture?: any[] } = {}) =>
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url: string, opts: any) => {
      if (opts && bodyCapture) bodyCapture.push(JSON.parse(opts.body));
      return { ok: true, json: async () => openaiJson(content) };
    }));

  const userCtx = (extra: Parameters<typeof makeCtx>[0] = {}) => makeCtx({ tier: tierInfo("user", "img-1"), ...extra });
  const post = (body: unknown) => makePost(body, { installId: "dev-img" });

  it("登录用户末条带图 → 200，parts 转换为 Responses 形态（input_text/input_image）", async () => {
    const bodies: any[] = [];
    stubFetchAuthed({ bodyCapture: bodies });
    const msg = { role: "user", content: [textPart("这是什么"), imagePart()] };
    const res = await call(post({ messages: [msg] }), userCtx());
    expect(res.status).toBe(200);
    const sent = bodies[0].input.at(-1);
    expect(Array.isArray(sent.content)).toBe(true);
    expect(sent.content[0]).toEqual({ type: "input_text", text: "这是什么" });
    expect(sent.content[1]).toEqual({ type: "input_image", image_url: dataUrl() });
  });

  it("纯图无文本也放行", async () => {
    stubFetchAuthed();
    const msg = { role: "user", content: [imagePart()] };
    const res = await call(post({ messages: [msg] }), userCtx());
    expect(res.status).toBe(200);
  });

  it("匿名带图 → 403 images_require_login", async () => {
    const msg = { role: "user", content: [textPart(), imagePart()] };
    const res = await call(makePost({ messages: [msg] }, { installId: "dev-anon" }), makeCtx());
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe("images_require_login");
  });

  it("图片出现在非末条（历史）→ 400 images_in_history", async () => {
    stubFetchAuthed();
    const res = await call(
      post({
        messages: [
          { role: "user", content: [textPart("旧图"), imagePart()] },
          { role: "assistant", content: "ok" },
          { role: "user", content: "hi" },
        ],
      }),
      userCtx(),
    );
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe("images_in_history");
  });

  it("超过默认 9 张 → 400 too_many_images", async () => {
    stubFetchAuthed();
    const msg = { role: "user", content: [textPart(), ...Array.from({ length: 10 }, () => imagePart())] };
    const res = await call(post({ messages: [msg] }), userCtx());
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe("too_many_images");
  });

  it("单张 base64 超限 → 400 image_too_large", async () => {
    stubFetchAuthed();
    const msg = { role: "user", content: [imagePart(500 * 1024 + 1)] };
    const res = await call(post({ messages: [msg] }), userCtx());
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe("image_too_large");
  });

  it("图片总量超限（默认闸 9×280KB×4/3+余量）→ 400 images_too_large", async () => {
    stubFetchAuthed();
    const msg = { role: "user", content: Array.from({ length: 9 }, () => imagePart(450 * 1024)) };
    const res = await call(post({ messages: [msg] }), userCtx());
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe("images_too_large");
  });

  it("KV 收紧 max_count 后即时生效（应急回缩路径）", async () => {
    stubFetchAuthed();
    const kv = { get: async (key: string) => (key === "chat_images" ? "{\"max_count\":2}" : null) };
    const msg = { role: "user", content: Array.from({ length: 3 }, () => imagePart()) };
    const res = await call(post({ messages: [msg] }), userCtx({ kv }));
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe("too_many_images");
  });

  it("http URL 图片 → 400 invalid_message_format（只收 data:image base64）", async () => {
    stubFetchAuthed();
    const msg = { role: "user", content: [{ type: "image_url", image_url: { url: "https://evil.example/a.jpg" } }] };
    const res = await call(post({ messages: [msg] }), userCtx());
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe("invalid_message_format");
  });

  it("parts 出现未知 type → 400 invalid_message_format", async () => {
    stubFetchAuthed();
    const msg = { role: "user", content: [{ type: "input_audio", data: "xx" }] };
    const res = await call(post({ messages: [msg] }), userCtx());
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe("invalid_message_format");
  });

  it("assistant 消息不允许 parts → 400 invalid_message_format", async () => {
    stubFetchAuthed();
    const res = await call(
      post({
        messages: [
          { role: "assistant", content: [textPart("ok")] },
          { role: "user", content: "hi" },
        ],
      }),
      userCtx(),
    );
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe("invalid_message_format");
  });

  it("带图消息的文本部分仍受上限 → 400 content_too_long", async () => {
    stubFetchAuthed();
    const msg = { role: "user", content: [textPart("x".repeat(MAX_CONTENT_LEN + 1)), imagePart()] };
    const res = await call(post({ messages: [msg] }), userCtx());
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe("content_too_long");
  });

  it("chat_logs 留痕记文本部分 + image_count", async () => {
    stubFetchAuthed();
    const ctx = userCtx();
    const msg = { role: "user", content: [textPart("识图"), imagePart(), imagePart()] };
    await call(post({ messages: [msg] }), ctx);
    const bound = findBound(ctx.db, "INSERT INTO chat_logs")!;
    // [install_id, day, created_at, content, lang, has_context, image_count]
    expect(bound[3]).toBe("识图");
    expect(bound[6]).toBe(2);
  });

  it("纯文本请求 chat_logs 的 image_count=0（兼容不回归）", async () => {
    stubFetchOk("ok");
    const ctx = makeCtx();
    await call(makePost({ messages: USER_MSG }), ctx);
    expect(findBound(ctx.db, "INSERT INTO chat_logs")![6]).toBe(0);
  });
});

describe("Chat API 历史预算", () => {
  it("16k 字符预算：带 6k 解读消息的多轮追问历史完整转发给上游（不被裁掉）", async () => {
    const bodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url: string, opts: any) => {
      if (opts) bodies.push(JSON.parse(opts.body));
      return { ok: true, json: async () => openaiJson("ok") };
    }));
    const summary = "解读全文".repeat(1500); // 6000 字符，模拟详细解读消息
    const messages = [
      { role: "user", content: "一键详细解读" },
      { role: "assistant", content: summary },
      { role: "user", content: "追问一" },
      { role: "assistant", content: "x".repeat(3000) },
      { role: "user", content: "刚才解读里提到的风险展开讲讲" },
    ]; // 总量 ~9.1k：旧 8k 预算会从最旧端裁掉解读，16k 预算应完整保留
    const res = await call(makePost({ messages }), makeCtx());
    expect(res.status).toBe(200);
    const sent = bodies[0].input.map((m: any) => m.content);
    expect(sent.some((c: unknown) => typeof c === "string" && c.includes("解读全文"))).toBe(true);
  });
});

describe("Chat API 双模式流式（stream: true）", () => {
  // OpenAI 流式 stub：断言请求体带 stream:true，返回 SSE 格式 body
  const stubFetchStream = (texts: string[], { bodyCapture }: { bodyCapture?: any[] } = {}) =>
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url: string, opts: any) => {
      if (bodyCapture && opts) bodyCapture.push(JSON.parse(opts.body));
      return sseUpstream(textStreamLines(texts));
    }));

  it("stream:true → SSE 响应，delta 拼接与非流式全文一致，末尾 done", async () => {
    const bodies: any[] = [];
    stubFetchStream(["你", "好"], { bodyCapture: bodies });
    const res = await call(makePost({ messages: USER_MSG, stream: true }), makeCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const events = parseFrames(await res.text());
    expect(events.filter((e) => e.delta).map((e) => e.delta).join("")).toBe("你好");
    expect(events.at(-1)).toEqual({ done: true });
    // 上游请求体带 stream 标记
    expect(bodies[0].stream).toBe(true);
  });

  it("stream:true 但余额耗尽 → 流开始前返回普通 429 JSON", async () => {
    const res = await call(makePost({ messages: USER_MSG, stream: true }), makeCtx({ db: { balance: 0 } }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Content-Type")).not.toBe("text/event-stream");
    expect((await json(res)).code).toBe("quota_device");
  });

  it("stream:true 成功走完 → pending 行结算为 ok（feature=chat）", async () => {
    stubFetchStream(["ok"]);
    const ctx = makeCtx();
    const res = await call(makePost({ messages: USER_MSG, stream: true }), ctx);
    await res.text(); // 消费完整个流
    // 预扣阶段：pending 行与扣款同批写入，feature 落在第 3 个绑定位
    const idx = ctx.db.prepare.mock.calls.findIndex(([sql]) => sql.includes("INSERT INTO usage_events"));
    expect(idx).not.toBe(-1);
    expect(ctx.db.prepare.mock.calls[idx][0]).toContain("'pending'");
    expect(ctx.db.bind.mock.calls[idx][2]).toBe("chat");
    // 结算阶段：条件 UPDATE 推向 ok，并带幂等锁
    const okSql = ctx.db.prepare.mock.calls
      .map(([sql]) => sql)
      .find((sql) => sql.includes("UPDATE usage_events") && sql.includes("status = 'ok'"));
    expect(okSql).toBeDefined();
    expect(okSql).toContain("status = 'pending'");
  });

  it("stream:true 上游非 2xx → 流开始前返回 502 JSON", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "boom" }));
    const res = await call(makePost({ messages: USER_MSG, stream: true }), makeCtx());
    expect(res.status).toBe(502);
    expect((await json(res)).code).toBe("upstream_error");
  });

  it("不带 stream 的旧请求体 → 仍是 JSON 响应（旧客户端兼容）", async () => {
    stubFetchOk("legacy");
    const res = await call(makePost({ messages: USER_MSG }), makeCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect((await json(res)).content).toBe("legacy");
  });
});

describe("Chat API 用户问题留痕", () => {
  it("记录本轮用户问题，且发生在配额检查之前（被限流也记）", async () => {
    const ctx = makeCtx({ db: { balance: 0 } }); // 余额耗尽 → 429
    const res = await call(
      makePost({ messages: [{ role: "assistant", content: "prev" }, { role: "user", content: "hi" }] }),
      ctx,
    );
    expect(res.status).toBe(429); // 仍被限流
    const bound = findBound(ctx.db, "INSERT INTO chat_logs");
    expect(bound).not.toBeNull();
    // [install_id, day, created_at, content, lang, has_context]
    expect(bound![0]).toBe("dev-1");
    expect(bound![3]).toBe("hi"); // 只记最后一条用户消息
    expect(bound![5]).toBe(0); // 无 context
  });

  it("带 context 时 has_context=1，lang 透传", async () => {
    stubFetchOk("ok");
    const ctx = makeCtx();
    await call(makePost({ messages: USER_MSG, lang: "zh", context: { title: "owner/repo" } }), ctx);
    const bound = findBound(ctx.db, "INSERT INTO chat_logs")!;
    expect(bound[4]).toBe("zh");
    expect(bound[5]).toBe(1);
  });

  it("日志写入失败不影响聊天主流程（尽力而为）", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetchOk("still ok");
    const ctx = makeCtx();
    // 只让 chat_logs 的写入抛错；账本相关 run（扣减/授予/事件）保持正常语义
    const originalRun = ctx.db.run.getMockImplementation()!;
    ctx.db.run.mockImplementation(async (sql: string, binds: any[]) => {
      if (sql.includes("INSERT INTO chat_logs")) throw new Error("boom");
      return originalRun(sql, binds);
    });
    const res = await call(makePost({ messages: USER_MSG }), ctx);
    expect(res.status).toBe(200);
    expect((await json(res)).content).toBe("still ok");
  });

  it("logging:false → 不写 chat_logs，主流程不变", async () => {
    stubFetchOk("ok");
    const ctx = makeCtx({ config: { logging: false } });
    const res = await call(makePost({ messages: USER_MSG }), ctx);
    expect(res.status).toBe(200);
    expect(hasSql(ctx.db, "INSERT INTO chat_logs")).toBe(false);
  });
});

describe("非流式遗留路径埋点", () => {
  it("缺省 stream（JSON 模式）→ 记录 legacy_json_mode 标记", async () => {
    stubFetchOk("ok");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await call(makePost({ messages: USER_MSG }), makeCtx());
    expect(res.status).toBe(200);
    expect(spy.mock.calls.some((c) => String(c[0]).includes("legacy_json_mode"))).toBe(true);
  });

  it("stream:true → 不记录 legacy_json_mode", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseUpstream([
      "{\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}",
      "{\"type\":\"response.completed\",\"response\":{}}",
    ])));
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await call(makePost({ messages: USER_MSG, stream: true }), makeCtx());
    await res.text();
    expect(spy.mock.calls.some((c) => String(c[0]).includes("legacy_json_mode"))).toBe(false);
  });
});

describe("Chat API web search（P2，Pro 专属）", () => {
  const proCtx = (balance = 5) => makeCtx({
    db: { userIdentity: { balance, last_grant_tier: "pro" } },
    tier: tierInfo("pro", "u-search"),
  });
  const proPost = (body: unknown) => makePost(body, { installId: "dev-search" });
  const stubStream = (bodyCapture: any[] | null) =>
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url: string, opts: any) => {
      if (bodyCapture && opts) bodyCapture.push(JSON.parse(opts.body));
      return sseUpstream(textStreamLines(["ok"], { input_tokens: 5, output_tokens: 2 }));
    }));

  it("匿名 search:true → 403 search_requires_pro，不预扣", async () => {
    const ctx = makeCtx({ db: { balance: 5 } });
    const res = await call(makePost({ messages: USER_MSG, stream: true, search: true }), ctx);
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe("search_requires_pro");
    expect(hasSql(ctx.db, "balance = balance - ?")).toBe(false);
  });

  it("Pro search:true → 上游挂 web_search 工具 + max_tool_calls 封顶 + 引用提示词", async () => {
    const bodies: any[] = [];
    stubStream(bodies);
    const res = await call(proPost({ messages: USER_MSG, stream: true, search: true, lang: "zh" }), proCtx());
    await res.text();
    expect(bodies[0].tools).toEqual([{ type: "web_search", search_context_size: "medium" }]);
    expect(bodies[0].max_tool_calls).toBe(3);
    // 合规：要求模型正文内联可点引用（官方要求 inline citation 可见可点）
    const system = bodies[0].input[0].content;
    expect(system).toContain("引用");
  });

  it("Pro search:true → 扣 3 credits，事件 feature=chat_search", async () => {
    stubStream(null);
    const ctx = proCtx();
    const res = await call(proPost({ messages: USER_MSG, stream: true, search: true }), ctx);
    await res.text();
    expect(findBound(ctx.db, "balance = balance - ?")![0]).toBe(3);
    expect(findBound(ctx.db, "INSERT INTO usage_events")![2]).toBe("chat_search");
  });

  it("Pro search:true 但余额只剩 2 → 429（3 credits 不够），带 resetAt", async () => {
    const res = await call(proPost({ messages: USER_MSG, stream: true, search: true }), proCtx(2));
    expect(res.status).toBe(429);
    const body = await json(res);
    expect(body.code).toBe("quota_device");
    expect(body.resetAt).toBeTruthy();
  });

  it("不带 search → 不挂工具、扣 1（普通对话零变化）", async () => {
    const bodies: any[] = [];
    stubStream(bodies);
    const ctx = makeCtx({ db: { balance: 5 } });
    const res = await call(makePost({ messages: USER_MSG, stream: true }), ctx);
    await res.text();
    expect("tools" in bodies[0]).toBe(false);
    expect(findBound(ctx.db, "balance = balance - ?")![0]).toBe(1);
  });
});

describe("Chat API 多厂商（DeepSeek，全部 Pro 专属）", () => {
  const IMG = "data:image/jpeg;base64," + "A".repeat(100);
  const imgMsg = [{ role: "user", content: [{ type: "text", text: "看图" }, { type: "image_url", image_url: { url: IMG } }] }];

  // 上游请求全部交给 upstream 回调
  const stubFetch = ({ upstream }: { upstream: (url: string, opts: any) => Promise<any> }) =>
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string, opts: any) => upstream(String(url), opts)));
  const proCtx = (providers: MakeCtxOpts["providers"] = { openai: { apiKey: "sk" } }) => makeCtx({
    db: { userIdentity: { balance: 90, last_grant_tier: "pro" } },
    tier: tierInfo("pro", "u-ds"),
    providers,
  });
  const withDs = { openai: { apiKey: "sk" }, deepseek: { apiKey: "sk-ds" } };
  const proPost = (body: unknown) => makePost(body, { installId: "dev-ds" });

  it("Pro 选 deepseek-v4-flash（旧名）→ 别名换成 deepseek-flash 打 api.deepseek.com，带 deepseek 凭据，账本记正式 id", async () => {
    const calls: any[] = [];
    stubFetch({ upstream: async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, json: async () => openaiJson("ds ok") };
    } });
    const ctx = proCtx(withDs);
    const res = await call(proPost({ messages: USER_MSG, model: "deepseek-v4-flash" }), ctx);
    expect(res.status).toBe(200);
    expect((await json(res)).content).toBe("ds ok");
    expect(calls[0].url).toBe("https://api.deepseek.com/v1/responses");
    expect(calls[0].opts.headers.Authorization).toBe("Bearer sk-ds");
    expect(JSON.parse(calls[0].opts.body).model).toBe("deepseek-flash");
    expect(findBound(ctx.db, "SET status = 'ok'")![0]).toBe("deepseek-flash");
  });

  it("非 Pro（匿名 / 登录）选 DeepSeek → 回落默认 OpenAI 模型", async () => {
    const calls: any[] = [];
    const upstream = async (url: string, opts: any) => {
      calls.push({ url, model: JSON.parse(opts.body).model });
      return { ok: true, json: async () => openaiJson("ok") };
    };
    stubFetch({ upstream });
    const anon = await call(makePost({ messages: USER_MSG, model: "deepseek-v4-flash" }), makeCtx({ db: { balance: 5 } }));
    expect(anon.status).toBe(200);
    expect(calls[0]).toEqual({ url: "https://api.openai.com/v1/responses", model: "gpt-5.6-luna" });

    const ctx = makeCtx({ db: { userIdentity: { balance: 5 } }, tier: tierInfo("user", "u-dsu"), providers: withDs });
    const user = await call(proPost({ messages: USER_MSG, model: "deepseek-v4-pro" }), ctx);
    expect(user.status).toBe(200);
    expect(calls[1]).toEqual({ url: "https://api.openai.com/v1/responses", model: "gpt-5.6-luna" });
  });

  it("DeepSeek V4 Pro 不接受图片 → 400 images_unsupported，且在计费闸之前（不预扣）", async () => {
    stubFetch({ upstream: async () => { throw new Error("should not call upstream"); } });
    const ctx = proCtx(withDs);
    const res = await call(proPost({ messages: imgMsg, model: "deepseek-v4-pro" }), ctx);
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe("images_unsupported");
    expect(hasSql(ctx.db, "balance = balance - ?")).toBe(false);
  });

  it("DeepSeek 不支持搜索 → 400 search_unsupported，不预扣", async () => {
    stubFetch({ upstream: async () => { throw new Error("should not call upstream"); } });
    const ctx = proCtx(withDs);
    const res = await call(proPost({ messages: USER_MSG, model: "deepseek-v4-flash", search: true, stream: true }), ctx);
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe("search_unsupported");
    expect(hasSql(ctx.db, "balance = balance - ?")).toBe(false);
  });

  it("deepseek 凭据未配置 → 502 upstream_error 并退还预扣", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch({ upstream: async () => { throw new Error("should not call upstream"); } });
    const ctx = proCtx();
    const res = await call(proPost({ messages: USER_MSG, model: "deepseek-v4-flash" }), ctx);
    expect(res.status).toBe(502);
    expect((await json(res)).code).toBe("upstream_error");
    expect(hasSql(ctx.db, "SET status = 'aborted'")).toBe(true);
  });
});

describe("Chat API 生图（imageGeneration:true）", () => {
  const B64 = "aGVsbG8="; // "hello"
  const stubFetch = ({ upstream }: { upstream: (url: string, opts: any) => Promise<any> }) =>
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string, opts: any) => upstream(String(url), opts)));
  // 上游流：先出一张图，再一段正文
  const imageStream = (bodies: any[]) => async (_url: string, opts: any) => {
    bodies.push(JSON.parse(opts.body));
    return sseUpstream([
      "{\"type\":\"response.image_generation_call.generating\",\"item_id\":\"ig_1\"}",
      `{"type":"response.output_item.done","item":{"type":"image_generation_call","status":"completed","result":"${B64}"}}`,
      "{\"type\":\"response.output_text.delta\",\"delta\":\"Here you go\"}",
      "{\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":50,\"output_tokens\":5}}}",
    ]);
  };
  const textOnlyStream = (bodies: any[]) => async (_url: string, opts: any) => {
    bodies.push(JSON.parse(opts.body));
    return sseUpstream(textStreamLines(["no image needed"], { input_tokens: 5, output_tokens: 2 }));
  };
  const proCtx = (extra: Parameters<typeof makeCtx>[0] = {}) => makeCtx({
    db: { userIdentity: { balance: 90, last_grant_tier: "pro" } },
    tier: tierInfo("pro", "u-img"),
    providers: { openai: { apiKey: "sk" } },
    images: fakeR2(),
    ...extra,
  });
  const proPost = (body: unknown) => makePost(body, { installId: "dev-img-gen" });
  const frames = async (res: Response) => parseFrames(await res.text());

  it("匿名 imageGeneration:true → 403 image_generation_requires_pro，不预扣", async () => {
    const ctx = makeCtx({ db: { balance: 5 } });
    const res = await call(makePost({ messages: USER_MSG, stream: true, imageGeneration: true }), ctx);
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe("image_generation_requires_pro");
    expect(hasSql(ctx.db, "balance = balance - ?")).toBe(false);
  });

  it("Pro 选 DeepSeek 开生图 → 400 image_generation_unsupported", async () => {
    stubFetch({ upstream: async () => { throw new Error("should not reach upstream"); } });
    const res = await call(
      proPost({ messages: USER_MSG, stream: true, imageGeneration: true, model: "deepseek-v4-flash" }),
      proCtx({ providers: { openai: { apiKey: "sk" }, deepseek: { apiKey: "sk-ds" } } }),
    );
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe("image_generation_unsupported");
  });

  it("Pro 非流式开生图 → 400 image_generation_requires_stream", async () => {
    stubFetch({ upstream: async () => { throw new Error("should not reach upstream"); } });
    const res = await call(proPost({ messages: USER_MSG, imageGeneration: true }), proCtx());
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe("image_generation_requires_stream");
  });

  it("images 未配置 → 400 image_generation_unsupported，在计费闸之前（不预扣、不打上游）", async () => {
    stubFetch({ upstream: async () => { throw new Error("should not reach upstream"); } });
    const ctx = proCtx({ images: undefined });
    const res = await call(proPost({ messages: USER_MSG, stream: true, imageGeneration: true }), ctx);
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe("image_generation_unsupported");
    expect(hasSql(ctx.db, "balance = balance - ?")).toBe(false);
  });

  it("Pro 开生图 → 挂厂商注册表的工具、max_tool_calls=1、prompt 换成工具指引、预扣 10、存 R2 后 Markdown 进 delta、成本含按张费", async () => {
    const bodies: any[] = [];
    stubFetch({ upstream: imageStream(bodies) });
    const ctx = proCtx();
    const res = await call(proPost({ messages: USER_MSG, stream: true, imageGeneration: true, lang: "zh" }), ctx);
    expect(res.status).toBe(200);
    const evs = await frames(res);

    expect(bodies[0].tools).toEqual([expect.objectContaining({ type: "image_generation", model: "gpt-image-2.5-flare", quality: "low" })]);
    expect(bodies[0].max_tool_calls).toBe(1);
    const system = bodies[0].input[0].content;
    expect(system).toContain("image_generation");
    expect(system).not.toContain("不能生成、绘制或修改图片");

    const put = (ctx.images as any).put as ReturnType<typeof vi.fn>;
    expect(evs[0]).toEqual({ imageGeneration: { state: "generating" } });
    expect(put).toHaveBeenCalledTimes(1);
    const [key, bytes, meta] = put.mock.calls[0];
    expect(key).toMatch(/^[0-9a-f-]{36}\.jpg$/);
    expect(new TextDecoder().decode(bytes)).toBe("hello");
    expect(meta.httpMetadata.contentType).toBe("image/jpeg");
    expect(evs[1]).toEqual({ imageGeneration: { state: "done" } });
    expect(evs[2].delta).toBe(`\n\n![](https://api.trendingai.cn/api/chat/generated-images/${key})\n\n`);
    expect(evs[3].delta).toBe("Here you go");
    expect(evs.at(-1)).toEqual({ done: true });

    expect(findBound(ctx.db, "balance = balance - ?")![0]).toBe(10);
    expect(findBound(ctx.db, "INSERT INTO usage_events")![2]).toBe("chat_image_generation");
    // luna 50 in / 5 out ≈ 16μ$ → ceil；加 20_000 按张费；credits 全额 10
    const settleBind = findBound(ctx.db, "SET status = 'ok'")!;
    expect(settleBind[3]).toBeGreaterThan(20_000);
    expect(settleBind[4]).toBe(10);
  });

  it("image 与 search 同开 → 只挂生图工具、max_tool_calls=1、按 chat_image_generation 计（互斥，生图优先）", async () => {
    const bodies: any[] = [];
    stubFetch({ upstream: imageStream(bodies) });
    const ctx = proCtx();
    const res = await call(proPost({ messages: USER_MSG, stream: true, imageGeneration: true, search: true }), ctx);
    await res.text();
    expect(bodies[0].tools.map((t: any) => t.type)).toEqual(["image_generation"]);
    expect(bodies[0].max_tool_calls).toBe(1);
    expect(bodies[0].input[0].content).not.toContain("引用");
    expect(findBound(ctx.db, "INSERT INTO usage_events")![2]).toBe("chat_image_generation");
  });

  it("Pro 开生图但模型没出图 → 只计 1，退还 9", async () => {
    const bodies: any[] = [];
    stubFetch({ upstream: textOnlyStream(bodies) });
    const ctx = proCtx();
    const res = await call(proPost({ messages: USER_MSG, stream: true, imageGeneration: true }), ctx);
    await res.text();
    expect((ctx.images as any).put).not.toHaveBeenCalled();
    expect(findBound(ctx.db, "SET status = 'ok'")![4]).toBe(1);
    expect(findBound(ctx.db, "balance = balance + ?")![0]).toBe(9);
  });

  it("开生图且历史里有我们签发的图 → 末条 user 消息追加该图为参考图；外链不认", async () => {
    const bodies: any[] = [];
    stubFetch({ upstream: imageStream(bodies) });
    const ours = "https://api.trendingai.cn/api/chat/generated-images/0f96c2cd-f61f-4208-86aa-38523fb54870.jpg";
    const messages = [
      { role: "user", content: "画只猫" },
      { role: "assistant", content: `\n\n![](${ours})\n\n好了` },
      { role: "user", content: "看看这个" },
      { role: "assistant", content: "![x](https://evil.example/pic.jpg)" },
      { role: "user", content: "把猫改成橘色" },
    ];
    const res = await call(proPost({ messages, stream: true, imageGeneration: true }), proCtx());
    await res.text();
    const last = bodies[0].input.at(-1);
    expect(last.role).toBe("user");
    expect(last.content).toEqual([
      { type: "input_text", text: "把猫改成橘色" },
      { type: "input_image", image_url: ours },
    ]);
  });

  it("不开生图 → 历史里的生成图不回带、不挂工具（普通对话零变化）", async () => {
    const bodies: any[] = [];
    stubFetch({ upstream: textOnlyStream(bodies) });
    const messages = [
      { role: "assistant", content: "![](https://api.trendingai.cn/api/chat/generated-images/0f96c2cd-f61f-4208-86aa-38523fb54870.jpg)" },
      { role: "user", content: "谢谢" },
    ];
    const res = await call(proPost({ messages, stream: true }), proCtx());
    await res.text();
    expect("tools" in bodies[0]).toBe(false);
    expect(bodies[0].input.at(-1).content).toBe("谢谢");
  });

  it("basePath=/v1 → 生成图 URL 与参考图识别都跟随挂载点", async () => {
    const bodies: any[] = [];
    stubFetch({ upstream: imageStream(bodies) });
    const ctx = proCtx({ basePath: "/v1" });
    const ours = "https://api.trendingai.cn/v1/chat/generated-images/0f96c2cd-f61f-4208-86aa-38523fb54870.jpg";
    const messages = [
      { role: "assistant", content: `![](${ours})` },
      { role: "user", content: "再来一张" },
    ];
    const res = await call(proPost({ messages, stream: true, imageGeneration: true }), ctx);
    const evs = await frames(res);
    expect(bodies[0].input.at(-1).content.at(-1)).toEqual({ type: "input_image", image_url: ours });
    expect(evs[2].delta).toMatch(/^\n\n!\[\]\(https:\/\/api\.trendingai\.cn\/v1\/chat\/generated-images\/[0-9a-f-]{36}\.jpg\)\n\n$/);
  });
});

// helpers 的 makeDB 也直接暴露给需要裸 db 的用例；这里钉住其扣减语义没被改坏
describe("fake D1 自检", () => {
  it("扣减依当前余额判定 changes", async () => {
    const db = makeDB({ balance: 1 });
    const stmt = db.prepare("UPDATE identities SET balance = balance - ? WHERE id = ? AND balance >= ?").bind(1, 1, 1);
    expect((await stmt.run()).meta.changes).toBe(1);
    expect((await stmt.run()).meta.changes).toBe(0);
  });
});
