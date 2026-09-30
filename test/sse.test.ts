import { describe, it, expect, vi } from "vitest";
import { sseOneShot, upstreamToSSE } from "../src/sse.js";
import type { Usage } from "../src/usage.js";

// ---------------------------------------------------------------------------
// 工具：构造 OpenAI 风格的上游流式 Response
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

// chunks: 字符串数组，按序推入；error=true 时推完后以错误收尾（模拟中途断流）
const makeUpstream = (chunks: string[], { error = false } = {}) =>
  new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      if (error) controller.error(new Error("upstream broke"));
      else controller.close();
    },
  }));

const openaiDelta = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

// 可手动控制节奏的上游（供断连场景：中途推送/收尾/报错），并暴露被取消状态
const makeManualUpstream = () => {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) { ctrl = c; },
    cancel() { cancelled = true; },
  });
  return {
    response: new Response(body),
    push: (text: string) => ctrl.enqueue(enc.encode(openaiDelta(text))),
    finish: (usage: Usage | null = null) => {
      if (usage) {
        ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [], usage })}\n\n`));
      }
      ctrl.enqueue(enc.encode("data: [DONE]\n\n"));
      ctrl.close();
    },
    fail: () => ctrl.error(new Error("upstream broke")),
    cancelled: () => cancelled,
  };
};

// 解析我们自己的 SSE 文本为事件对象数组
const parseEvents = (text: string) =>
  text.split("\n\n").filter(Boolean).map((block: string) => JSON.parse(block.replace(/^data: /, "")));

describe("sseOneShot", () => {
  it("全文一次性推完：一个 delta 事件 + 一个 done 事件", async () => {
    const res = sseOneShot("全文内容");
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const events = parseEvents(await res.text());
    expect(events).toEqual([{ delta: "全文内容" }, { done: true }]);
  });

  it("done 事件可携带元信息", async () => {
    const res = sseOneShot("x", { cached: true });
    const events = parseEvents(await res.text());
    expect(events[1]).toEqual({ done: true, cached: true });
  });
});

describe("upstreamToSSE", () => {
  it("OpenAI delta 流转为 {delta} 事件流，[DONE] 转为 {done:true}", async () => {
    const upstream = makeUpstream([
      openaiDelta("He"),
      openaiDelta("llo"),
      "data: [DONE]\n\n",
    ]);
    const res = upstreamToSSE(upstream);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const events = parseEvents(await res.text());
    expect(events).toEqual([{ delta: "He" }, { delta: "llo" }, { done: true }]);
  });

  it("事件跨 chunk 边界拆分时仍正确解析（缓冲拼接）", async () => {
    const full = openaiDelta("Hello world");
    const upstream = makeUpstream([
      full.slice(0, 17),
      full.slice(17),
      "data: [DONE]\n\n",
    ]);
    const res = upstreamToSSE(upstream);
    const events = parseEvents(await res.text());
    expect(events).toEqual([{ delta: "Hello world" }, { done: true }]);
  });

  it("正常走完时 onComplete 收到全文与 usage", async () => {
    const onComplete = vi.fn();
    const upstream = makeUpstream([
      openaiDelta("He"),
      openaiDelta("llo"),
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`,
      "data: [DONE]\n\n",
    ]);
    await upstreamToSSE(upstream, { onComplete }).text();
    expect(onComplete).toHaveBeenCalledWith("Hello", { prompt_tokens: 10, completion_tokens: 5 });
  });

  it("done 事件在 onComplete 完成之后才发出（保证计数/写缓存不被流关闭截断）", async () => {
    const order = [];
    const onComplete = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push("complete");
    });
    const upstream = makeUpstream([openaiDelta("x"), "data: [DONE]\n\n"]);
    const events = parseEvents(await upstreamToSSE(upstream, { onComplete }).text());
    order.push("stream-ended");
    expect(events.at(-1)).toEqual({ done: true });
    expect(order).toEqual(["complete", "stream-ended"]);
  });

  it("上游中途断流 → 流以错误收尾，不发 done、不调 onComplete", async () => {
    const onComplete = vi.fn();
    const upstream = makeUpstream([openaiDelta("部分")], { error: true });
    const res = upstreamToSSE(upstream, { onComplete });
    await expect(res.text()).rejects.toThrow();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("上游结束但没有 [DONE]（异常收尾）→ 同样按断流处理", async () => {
    const onComplete = vi.fn();
    const upstream = makeUpstream([openaiDelta("部分")]); // close 但无 [DONE]
    const res = upstreamToSSE(upstream, { onComplete });
    await expect(res.text()).rejects.toThrow();
    expect(onComplete).not.toHaveBeenCalled();
  });
});

describe("upstreamToSSE 客户端断连处理", () => {
  it("断开且无 waitUntil → 取消上游读取，不调 onComplete（chat 语义不变）", async () => {
    const up = makeManualUpstream();
    const onComplete = vi.fn();
    const res = upstreamToSSE(up.response, { onComplete });
    const reader = res.body!.getReader();
    up.push("第一段");
    await reader.read();
    await reader.cancel(); // 客户端断开
    await vi.waitFor(() => expect(up.cancelled()).toBe(true));
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("断开 + waitUntil → 后台继续读完上游，onComplete 仍以全文 + usage 调用", async () => {
    const up = makeManualUpstream();
    const onComplete = vi.fn();
    const tasks: Promise<unknown>[] = [];
    const res = upstreamToSSE(up.response, {
      onComplete,
      waitUntil: (p) => tasks.push(p),
    });
    const reader = res.body!.getReader();
    up.push("第一段");
    await reader.read();
    await reader.cancel(); // 客户端断开
    up.push("第二段");
    up.finish({ prompt_tokens: 100, completion_tokens: 50 });
    expect(tasks).toHaveLength(1); // 后台任务已交给 waitUntil 兜底
    await Promise.all(tasks);
    expect(onComplete).toHaveBeenCalledWith(
      "第一段第二段",
      { prompt_tokens: 100, completion_tokens: 50 },
    );
    expect(up.cancelled()).toBe(false); // 上游被读完而非取消
  });

  it("断开后上游报错 → 后台任务正常收敛（controller.error 不抛未捕获异常）", async () => {
    const up = makeManualUpstream();
    const onComplete = vi.fn();
    const tasks: Promise<unknown>[] = [];
    const res = upstreamToSSE(up.response, {
      onComplete,
      waitUntil: (p) => tasks.push(p),
    });
    const reader = res.body!.getReader();
    up.push("片段");
    await reader.read();
    await reader.cancel();
    up.fail();
    expect(tasks).toHaveLength(1);
    await expect(Promise.all(tasks)).resolves.toBeDefined();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("客户端不断开 + waitUntil → 正常流式收尾（delta → done），onComplete 在 done 前完成", async () => {
    const up = makeManualUpstream();
    const order = [];
    const tasks: Promise<unknown>[] = [];
    const res = upstreamToSSE(up.response, {
      onComplete: async () => { order.push("onComplete"); },
      waitUntil: (p) => tasks.push(p),
    });
    up.push("全文");
    up.finish();
    const text = await res.text();
    order.push("streamClosed");
    expect(parseEvents(text)).toEqual([{ delta: "全文" }, { done: true }]);
    expect(order).toEqual(["onComplete", "streamClosed"]);
    expect(tasks).toHaveLength(1);
    await Promise.all(tasks);
  });
});

// ---------------------------------------------------------------------------
// Responses API 上游格式（P0-5 迁移）：语义化事件替代 choices/[DONE]
// ---------------------------------------------------------------------------

describe("upstreamToSSE · Responses API 上游格式", () => {
  const enc2 = new TextEncoder();
  const respDelta = (text: string) => `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`;
  const respCompleted = (usage = { input_tokens: 10, output_tokens: 5 }) =>
    `data: ${JSON.stringify({ type: "response.completed", response: { usage } })}\n\n`;

  const upstreamOf = (chunks: string[]) => new Response(new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const c of chunks) ctrl.enqueue(enc2.encode(c));
      ctrl.close();
    },
  }), { status: 200 });

  const parseAll = async (res: Response) =>
    (await res.text()).split("\n\n").filter(Boolean).map((b: string) => JSON.parse(b.replace(/^data: /, "")));

  it("output_text.delta 转 {delta}，response.completed 收尾并携带归一化 usage 给 onComplete", async () => {
    let seen: { fullText: string; usage: Usage | null } | null = null;
    const res = upstreamToSSE(upstreamOf([respDelta("He"), respDelta("llo"), respCompleted()]), {
      onComplete: (fullText, usage) => { seen = { fullText, usage }; },
    });
    const events = await parseAll(res);
    expect(events).toEqual([{ delta: "He" }, { delta: "llo" }, { done: true }]);
    expect(seen!.fullText).toBe("Hello");
    expect(seen!.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5 });
  });

  it("无 response.completed 即结束 → 按断流处理（流报错，onComplete 不调、onAbort 调）", async () => {
    let completed = false;
    let aborted = false;
    const res = upstreamToSSE(upstreamOf([respDelta("He")]), {
      onComplete: () => { completed = true; },
      onAbort: () => { aborted = true; },
    });
    await expect(res.text()).rejects.toThrow();
    expect(completed).toBe(false);
    expect(aborted).toBe(true);
  });

  it("未知语义事件（如 reasoning 增量）被忽略不进客户端流", async () => {
    // web_search_call 事件自 P2 起会被翻译转发，改用 reasoning 事件验证「未知即忽略」
    const res = upstreamToSSE(upstreamOf([
      `data: ${JSON.stringify({ type: "response.reasoning_summary_text.delta", delta: "思考中" })}\n\n`,
      respDelta("ok"),
      respCompleted(),
    ]), {});
    const events = await parseAll(res);
    expect(events).toEqual([{ delta: "ok" }, { done: true }]);
  });
});

describe("upstreamToSSE · Responses API 终态事件语义（审查修复）", () => {
  const enc3 = new TextEncoder();
  const d = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
  const upstream3 = (chunks: string[]) => new Response(new ReadableStream<Uint8Array>({
    start(ctrl) { for (const c of chunks) ctrl.enqueue(enc3.encode(c)); ctrl.close(); },
  }), { status: 200 });
  const parse3 = async (res: Response) =>
    (await res.text()).split("\n\n").filter(Boolean).map((b: string) => JSON.parse(b.replace(/^data: /, "")));

  it("response.incomplete（触 max_output_tokens）→ 正常收尾：done 事件 + onComplete（等价旧 length 截断仍发 [DONE]）", async () => {
    let seen: { fullText: string; usage: Usage | null } | null = null;
    const res = upstreamToSSE(upstream3([
      d({ type: "response.output_text.delta", delta: "长回答" }),
      d({ type: "response.incomplete", response: { usage: { input_tokens: 9, output_tokens: 2048 } } }),
    ]), { onComplete: (fullText, usage) => { seen = { fullText, usage }; } });
    const events = await parse3(res);
    expect(events.at(-1)).toEqual({ done: true });
    expect(seen!.fullText).toBe("长回答");
    expect(seen!.usage).toEqual({ prompt_tokens: 9, completion_tokens: 2048 });
  });

  it("response.failed → 断流语义：流报错、onAbort 调、onComplete 不调", async () => {
    let completed = false;
    let aborted = false;
    const res = upstreamToSSE(upstream3([
      d({ type: "response.output_text.delta", delta: "x" }),
      d({ type: "response.failed", response: {} }),
    ]), { onComplete: () => { completed = true; }, onAbort: () => { aborted = true; } });
    await expect(res.text()).rejects.toThrow();
    expect(completed).toBe(false);
    expect(aborted).toBe(true);
  });

  it("error 事件 → 断流语义", async () => {
    let aborted = false;
    const res = upstreamToSSE(upstream3([
      d({ type: "error", message: "boom" }),
    ]), { onAbort: () => { aborted = true; } });
    await expect(res.text()).rejects.toThrow();
    expect(aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P2 web search：上游搜索语义事件 → 下游客户端协议
//   {"search":{"state":"started"}}                      搜索开始（每次调用一条，按 item_id 去重）
//   {"search":{"state":"done","query":"..."}}           单次搜索完成（query 尽力而为）
//   {"source":{"title":"...","url":"..."}}              引用来源（url_citation，按 url 去重）
// 旧客户端忽略未知行（ignoreUnknownKeys），零影响
// ---------------------------------------------------------------------------

describe("upstreamToSSE · web search 事件翻译", () => {
  const encW = new TextEncoder();
  const dW = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
  const upstreamW = (chunks: string[]) => new Response(new ReadableStream<Uint8Array>({
    start(ctrl) { for (const c of chunks) ctrl.enqueue(encW.encode(c)); ctrl.close(); },
  }), { status: 200 });
  const parseW = async (res: Response): Promise<any[]> =>
    (await res.text()).split("\n\n").filter(Boolean).map((b: string) => JSON.parse(b.replace(/^data: /, "")));

  it("searching→done→annotation 全链路翻译，事件与正文交错保序", async () => {
    const res = upstreamToSSE(upstreamW([
      dW({ type: "response.web_search_call.searching", item_id: "ws_1" }),
      dW({ type: "response.output_item.done", item: { type: "web_search_call", id: "ws_1", action: { type: "search", query: "kotlin 2.4" } } }),
      dW({ type: "response.output_text.delta", delta: "答案" }),
      dW({ type: "response.output_text.annotation.added", annotation: { type: "url_citation", url: "https://kotlinlang.org", title: "Kotlin" } }),
      dW({ type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 2 } } }),
    ]), {});
    const events = await parseW(res);
    expect(events).toEqual([
      { search: { state: "started" } },
      { search: { state: "done", query: "kotlin 2.4" } },
      { delta: "答案" },
      { source: { title: "Kotlin", url: "https://kotlinlang.org" } },
      { done: true },
    ]);
  });

  it("同一 item 的重复 searching 只发一条 started；同 url 引用去重", async () => {
    const res = upstreamToSSE(upstreamW([
      dW({ type: "response.web_search_call.in_progress", item_id: "ws_1" }),
      dW({ type: "response.web_search_call.searching", item_id: "ws_1" }),
      dW({ type: "response.web_search_call.searching", item_id: "ws_1" }),
      dW({ type: "response.output_text.annotation.added", annotation: { type: "url_citation", url: "https://a.dev", title: "A" } }),
      dW({ type: "response.output_text.annotation.added", annotation: { type: "url_citation", url: "https://a.dev", title: "A" } }),
      dW({ type: "response.output_text.delta", delta: "ok" }),
      dW({ type: "response.completed", response: {} }),
    ]), {});
    const events = await parseW(res);
    expect(events.filter((e: any) => e.search?.state === "started").length).toBe(1);
    expect(events.filter((e: any) => e.source).length).toBe(1);
  });

  it("output_item.done 无 query（open_page 等动作）→ done 事件省略 query 字段", async () => {
    const res = upstreamToSSE(upstreamW([
      dW({ type: "response.web_search_call.searching", item_id: "ws_2" }),
      dW({ type: "response.output_item.done", item: { type: "web_search_call", id: "ws_2", action: { type: "open_page" } } }),
      dW({ type: "response.output_text.delta", delta: "x" }),
      dW({ type: "response.completed", response: {} }),
    ]), {});
    const events = await parseW(res);
    const done = events.find((e: any) => e.search?.state === "done");
    expect(done).toEqual({ search: { state: "done" } });
  });

  it("onComplete 的 usage 携带 search_calls（按 output_item.done 的 web_search_call 计数，计按次费）", async () => {
    let seen: Usage | null = null;
    const res = upstreamToSSE(upstreamW([
      dW({ type: "response.output_item.done", item: { type: "web_search_call", id: "ws_1", action: { type: "search", query: "a" } } }),
      dW({ type: "response.output_item.done", item: { type: "web_search_call", id: "ws_2", action: { type: "open_page" } } }),
      dW({ type: "response.output_text.delta", delta: "答案" }),
      dW({ type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 2 } } }),
    ]), { onComplete: (fullText, usage) => { seen = usage; } });
    await parseW(res);
    expect(seen).toEqual({ prompt_tokens: 5, completion_tokens: 2, search_calls: 2 });
  });

  it("无搜索调用 → usage 不带 search_calls（非搜索路径形状不变）", async () => {
    let seen: Usage | null = null;
    const res = upstreamToSSE(upstreamW([
      dW({ type: "response.output_text.delta", delta: "ok" }),
      dW({ type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 2 } } }),
    ]), { onComplete: (fullText, usage) => { seen = usage; } });
    await parseW(res);
    expect(seen).toEqual({ prompt_tokens: 5, completion_tokens: 2 });
  });

  it("非 web_search 的 output_item.done（message 项）不产生 search 事件", async () => {
    const res = upstreamToSSE(upstreamW([
      dW({ type: "response.output_text.delta", delta: "ok" }),
      dW({ type: "response.output_item.done", item: { type: "message" } }),
      dW({ type: "response.completed", response: {} }),
    ]), {});
    const events = await parseW(res);
    expect(events.some((e: any) => e.search)).toBe(false);
  });
});
