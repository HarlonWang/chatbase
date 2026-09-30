import { describe, it, expect, vi, afterEach } from "vitest";
import { callChat, type ChatMessage } from "../src/llm.js";
import type { ChatContext } from "../src/config.js";

// 模型调用公共层：chat 与语音转写共用，统一超时与重试语义。
// 契约：流式 → {response}；非流式 → {content, usage}；失败 → {error, code}

const ctxWith = (providers: ChatContext["providers"]) => ({ providers }) as ChatContext;
const CTX = ctxWith({ openai: { apiKey: "sk-test" } });
const MSGS: ChatMessage[] = [{ role: "user", content: "hi" }];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("callChat 非流式（Responses API）", () => {
  it("成功 → 从 output 提取 content，usage 归一化为 prompt/completion_tokens", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: any) => {
      urls.push(String(url));
      return {
        ok: true,
        json: async () => ({
          output: [
            { type: "reasoning", summary: [] },
            { type: "message", content: [{ type: "output_text", text: "hello" }] },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      };
    }));
    const r = await callChat(CTX, { messages: MSGS, model: "gpt-5.4", maxTokens: 100 });
    expect(urls[0]).toContain("/v1/responses");
    expect(r.content).toBe("hello");
    // 归一化：计费层（settleUsage）与缓存层继续读 prompt/completion_tokens，调用方零改动
    expect(r.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5 });
  });

  it("output 含 web_search_call 项 → usage.search_calls 计数（按次费 $10/1k calls 的计费依据）", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [
          { type: "web_search_call", action: { type: "search", query: "a" } },
          { type: "web_search_call", action: { type: "open_page" } },
          { type: "message", content: [{ type: "output_text", text: "hello" }] },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    }));
    const r = await callChat(CTX, { messages: MSGS, model: "gpt-5.4", maxTokens: 100 });
    expect(r.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, search_calls: 2 });
  });

  it("无 web_search_call 项 → usage 不带 search_calls（非搜索路径形状不变）", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [{ type: "message", content: [{ type: "output_text", text: "hello" }] }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    }));
    const r = await callChat(CTX, { messages: MSGS, model: "gpt-5.4", maxTokens: 100 });
    expect(r.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5 });
  });

  it("空 output → upstream_error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ output: [] }) }));
    const r = await callChat(CTX, { messages: MSGS, model: "gpt-5.4", maxTokens: 100 });
    expect(r.code).toBe("upstream_error");
  });
});

describe("callChat 重试语义", () => {
  it("retry=1：首次 500 重试成功", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => "boom" })
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
      }) });
    vi.stubGlobal("fetch", fetchFn);
    const r = await callChat(CTX, { messages: MSGS, model: "gpt-5.4", maxTokens: 100, retry: 1 });
    expect(r.content).toBe("ok");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("retry=1：4xx 非限流不重试", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => "bad" });
    vi.stubGlobal("fetch", fetchFn);
    const r = await callChat(CTX, { messages: MSGS, model: "gpt-5.4", maxTokens: 100, retry: 1 });
    expect(r.code).toBe("upstream_error");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("403 地区拒绝 → upstream_region_blocked，且不重试（重试必然同样被拒）", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const body = JSON.stringify({
      error: { code: "unsupported_country_region_territory", message: "Country, region, or territory not supported" },
    });
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => body });
    vi.stubGlobal("fetch", fetchFn);
    const r = await callChat(CTX, { messages: MSGS, model: "gpt-5.4", maxTokens: 100, retry: 1 });
    expect(r.code).toBe("upstream_region_blocked");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("403 但非地区原因 → 仍是 upstream_error（别把权限问题误报成地区限制）", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 403, text: async () => JSON.stringify({ error: { code: "insufficient_permissions" } }),
    }));
    const r = await callChat(CTX, { messages: MSGS, model: "gpt-5.4", maxTokens: 100 });
    expect(r.code).toBe("upstream_error");
  });

  it("超时（AbortError）→ upstream_timeout", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" })));
    const r = await callChat(CTX, { messages: MSGS, model: "gpt-5.4", maxTokens: 100 });
    expect(r.code).toBe("upstream_timeout");
  });
});

describe("callChat 流式", () => {
  it("stream:true → 原样返回上游 Response，请求体带 stream 与 include_usage", async () => {
    const bodies: any[] = [];
    const upstream = new Response("x", { status: 200 });
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url: any, opts: any) => {
      bodies.push(JSON.parse(opts.body));
      return upstream;
    }));
    const r = await callChat(CTX, { messages: MSGS, model: "gpt-5.4", maxTokens: 100, stream: true });
    expect(r.response).toBe(upstream);
    expect(bodies[0].stream).toBe(true);
    // Responses API 参数形态：input + max_output_tokens（不再有 messages/stream_options）
    expect(bodies[0].input).toEqual(MSGS);
    expect(bodies[0].max_output_tokens).toBe(100);
    expect("messages" in bodies[0]).toBe(false);
    // 不传 temperature：gpt-5 系推理模型只接受默认值
    expect("temperature" in bodies[0]).toBe(false);
  });
});

describe("callChat · Responses API 行为等价修复（审查）", () => {
  it("显式 store:true——账户已开 data sharing，关 store 的隐私收益已被抵消，放开以解锁 previous_response_id 与 Logs 排查", async () => {
    const bodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url: any, opts: any) => {
      bodies.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }) };
    }));
    await callChat(CTX, { messages: MSGS, model: "gpt-5.4", maxTokens: 100 });
    expect(bodies[0].store).toBe(true);
  });

  it("多模态 parts 转换：text→input_text、image_url→input_image；纯字符串消息不动", async () => {
    const bodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url: any, opts: any) => {
      bodies.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }) };
    }));
    const messages: ChatMessage[] = [
      { role: "assistant", content: "历史回复" },
      { role: "user", content: [
        { type: "text", text: "这是什么" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAA" } },
      ] },
    ];
    await callChat(CTX, { messages, model: "gpt-5.4", maxTokens: 100 });
    expect(bodies[0].input[0]).toEqual({ role: "assistant", content: "历史回复" });
    expect(bodies[0].input[1]).toEqual({
      role: "user",
      content: [
        { type: "input_text", text: "这是什么" },
        { type: "input_image", image_url: "data:image/jpeg;base64,AAA" },
      ],
    });
  });
});

describe("callChat · hosted 工具挂载（P2 web search）", () => {
  const okJson = { ok: true, json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }) };

  it("传 tools 与 maxToolCalls → 请求体携带（成本封顶靠 max_tool_calls）", async () => {
    const bodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url: any, opts: any) => {
      bodies.push(JSON.parse(opts.body));
      return okJson;
    }));
    await callChat(CTX, {
      messages: MSGS, model: "gpt-5.4", maxTokens: 100,
      tools: [{ type: "web_search", search_context_size: "medium" }],
      maxToolCalls: 3,
    });
    expect(bodies[0].tools).toEqual([{ type: "web_search", search_context_size: "medium" }]);
    expect(bodies[0].max_tool_calls).toBe(3);
  });

  it("不传 tools → 请求体不带 tools/max_tool_calls（普通对话零变化）", async () => {
    const bodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url: any, opts: any) => {
      bodies.push(JSON.parse(opts.body));
      return okJson;
    }));
    await callChat(CTX, { messages: MSGS, model: "gpt-5.4", maxTokens: 100 });
    expect("tools" in bodies[0]).toBe(false);
    expect("max_tool_calls" in bodies[0]).toBe(false);
  });
});

// 中转回落：直连吃到 403 时改走非 CF 中转（AWS Lambda）。
// 关键契约是「403 一律回落、不读 body 判定」——大 body 被地区拒绝时 403 的 body
// 可能整个读不到；非 403 的错误与海外成功路径必须零改变。

const RELAY_CTX = ctxWith({
  openai: { apiKey: "sk-test", relay: { url: "https://relay.example/v1", token: "tok-123" } },
});
const regionBlocked = () => new Response(
  JSON.stringify({ error: { code: "unsupported_country_region_territory" } }),
  { status: 403 },
);

describe("中转回落", () => {
  it("地区拒绝 + 已配置中转 → 改打中转，带 x-relay-token 且剥掉 Authorization", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: any, opts: any) => {
      calls.push({ url: String(url), headers: opts.headers });
      if (calls.length === 1) return regionBlocked();
      return {
        ok: true,
        json: async () => ({
          output: [{ type: "message", content: [{ type: "output_text", text: "relayed" }] }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      };
    }));

    const r = await callChat(RELAY_CTX, { messages: MSGS, model: "gpt-5.4", maxTokens: 10 });

    expect(r.content).toBe("relayed");
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://api.openai.com/v1/responses");
    expect(calls[1].url).toBe("https://relay.example/v1/responses");
    expect(calls[1].headers["x-relay-token"]).toBe("tok-123");
    // 真 key 只存中转端，Worker 侧不再发一程
    expect("Authorization" in calls[1].headers).toBe(false);
    // 请求体原样重发（body 是字符串，可安全重用）
    expect(calls[1].headers["Content-Type"]).toBe("application/json");
  });

  it("地区拒绝但未配置中转 → 不回落，维持 upstream_region_blocked", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => regionBlocked());
    vi.stubGlobal("fetch", fetchMock);

    const r = await callChat(CTX, { messages: MSGS, model: "gpt-5.4", maxTokens: 10 });

    expect(r.code).toBe("upstream_region_blocked");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("body 为空的 403（大 body 下上游提前断连）→ 照样回落救活", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: any) => {
      calls.push(String(url));
      if (calls.length === 1) return new Response(null, { status: 403 });
      return {
        ok: true,
        json: async () => ({
          output: [{ type: "message", content: [{ type: "output_text", text: "relayed" }] }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      };
    }));

    const r = await callChat(RELAY_CTX, { messages: MSGS, model: "gpt-5.4", maxTokens: 10 });

    expect(r.content).toBe("relayed");
    expect(calls[1]).toBe("https://relay.example/v1/responses");
  });

  it("非地区原因的 403 → 回落是无害空转：中转同样 403 时交还原始响应", async () => {
    const notRegion = () => new Response(
      JSON.stringify({ error: { code: "insufficient_permissions" } }), { status: 403 });
    let n = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => (++n, notRegion())));

    const r = await callChat(RELAY_CTX, { messages: MSGS, model: "gpt-5.4", maxTokens: 10 });

    expect(r.code).toBe("upstream_error");
    expect(r.error).toContain("403");
    expect(n).toBe(2);
  });

  it("直连成功 → 海外路径零改变，不多打一跳", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [{ type: "message", content: [{ type: "output_text", text: "direct" }] }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const r = await callChat(RELAY_CTX, { messages: MSGS, model: "gpt-5.4", maxTokens: 10 });

    expect(r.content).toBe("direct");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("api.openai.com");
  });

  it("流式下地区拒绝 → 回落后原样返回中转 Response（403 在响应头阶段，流未开始）", async () => {
    const relayed = new Response("data: x\n\n", { status: 200 });
    let n = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => (++n === 1 ? regionBlocked() : relayed)));

    const r = await callChat(RELAY_CTX, { messages: MSGS, model: "gpt-5.4", maxTokens: 10, stream: true });

    expect(r.response).toBe(relayed);
    expect(n).toBe(2);
  });

  it("中转打不通 → 交还原始 403，维持 region_blocked 文案而非误导性的「稍后再试」", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      if (++n === 1) return regionBlocked();
      throw new Error("relay unreachable");
    }));

    const r = await callChat(RELAY_CTX, { messages: MSGS, model: "gpt-5.4", maxTokens: 10 });

    expect(r.code).toBe("upstream_region_blocked");
    expect(n).toBe(2);
  });

  it("中转返回非 2xx → 同样交还原始 403，不退化成 upstream_error", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () =>
      (++n === 1 ? regionBlocked() : new Response("boom", { status: 502 }))));

    const r = await callChat(RELAY_CTX, { messages: MSGS, model: "gpt-5.4", maxTokens: 10 });

    expect(r.code).toBe("upstream_region_blocked");
  });
});

// 多厂商：厂商差异只来自 providers.ts 注册表，公共层按 model 查表

describe("callChat · 按模型选厂商（DeepSeek）", () => {
  const okJson = (text = "hi") => ({
    ok: true,
    json: async () => ({
      output: [{ type: "message", content: [{ type: "output_text", text }] }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
  });

  it("deepseek 模型 → 打 api.deepseek.com、带 deepseek 的 apiKey、请求体追加 reasoning.effort none", async () => {
    const calls: { url: string; opts: any }[] = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: any, opts: any) => {
      calls.push({ url: String(url), opts });
      return okJson();
    }));
    const ctx = ctxWith({ openai: { apiKey: "sk-openai" }, deepseek: { apiKey: "sk-ds" } });
    const r = await callChat(ctx, { messages: MSGS, model: "deepseek-v4-flash", maxTokens: 100 });
    expect(r.content).toBe("hi");
    expect(calls[0].url).toBe("https://api.deepseek.com/v1/responses");
    expect(calls[0].opts.headers.Authorization).toBe("Bearer sk-ds");
    const body = JSON.parse(calls[0].opts.body);
    expect(body.model).toBe("deepseek-v4-flash");
    expect(body.reasoning).toEqual({ effort: "none" });
  });

  it("zhipu 模型 → 打 open.bigmodel.cn/api/v1、带 zhipu 的 apiKey、effort low、store 覆盖成 false", async () => {
    const calls: { url: string; opts: any }[] = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: any, opts: any) => {
      calls.push({ url: String(url), opts });
      return okJson();
    }));
    const ctx = ctxWith({ openai: { apiKey: "sk-openai" }, zhipu: { apiKey: "sk-zh" } });
    const r = await callChat(ctx, { messages: MSGS, model: "glm-5.3", maxTokens: 100 });
    expect(r.content).toBe("hi");
    expect(calls[0].url).toBe("https://open.bigmodel.cn/api/v1/responses");
    expect(calls[0].opts.headers.Authorization).toBe("Bearer sk-zh");
    const body = JSON.parse(calls[0].opts.body);
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.store).toBe(false);
  });

  it("OpenAI 模型的请求体不带 reasoning（厂商默认字段互不串）", async () => {
    const calls: any[] = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url: any, opts: any) => { calls.push(opts); return okJson(); }));
    await callChat(ctxWith({ openai: { apiKey: "sk" } }), { messages: MSGS, model: "gpt-5.6-luna", maxTokens: 100 });
    expect("reasoning" in JSON.parse(calls[0].body)).toBe(false);
  });

  it("厂商 key 未配置 → 不发请求，直接 upstream_error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const r = await callChat(ctxWith({ openai: { apiKey: "sk" } }), { messages: MSGS, model: "deepseek-v4-flash", maxTokens: 100 });
    expect(r.code).toBe("upstream_error");
    expect(f).not.toHaveBeenCalled();
  });

  it("DeepSeek 403 不回落中转（relay:false），维持直连结果", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => "forbidden" });
    vi.stubGlobal("fetch", f);
    const ctx = ctxWith({
      deepseek: { apiKey: "sk-ds" },
      openai: { apiKey: "", relay: { url: "https://relay", token: "t" } },
    });
    const r = await callChat(ctx, { messages: MSGS, model: "deepseek-v4-flash", maxTokens: 10 });
    expect(r.code).toBe("upstream_error");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("多个 message 项 → 取最后一个（DeepSeek 搜索旁白在前、最终答案在后）", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [
          { type: "message", phase: "commentary", content: [{ type: "output_text", text: "我来搜索一下" }] },
          { type: "web_search_call" },
          { type: "message", phase: "final_answer", content: [{ type: "output_text", text: "最终答案" }] },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    }));
    const r = await callChat(ctxWith({ deepseek: { apiKey: "k" } }), { messages: MSGS, model: "deepseek-v4-flash", maxTokens: 100 });
    expect(r.content).toBe("最终答案");
  });

  it("usage 带缓存命中明细 → 归一化附 cached_tokens", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [{ type: "message", content: [{ type: "output_text", text: "x" }] }],
        usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 80 }, output_tokens: 5 },
      }),
    }));
    const r = await callChat(ctxWith({ deepseek: { apiKey: "k" } }), { messages: MSGS, model: "deepseek-v4-flash", maxTokens: 100 });
    expect(r.usage).toEqual({ prompt_tokens: 100, completion_tokens: 5, cached_tokens: 80 });
  });
});
