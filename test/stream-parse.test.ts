import { describe, it, expect } from "vitest";
import { parseResponsesEvents, type ParseOptions, type StreamEvent, type StreamResult } from "../src/stream-parse.js";

// 上游流 → 统一事件。DeepSeek 与 OpenAI 事件同构，差异在收尾（无 [DONE]）与帧前的 event: 行

const enc = new TextEncoder();
const readerOf = (chunks: string[], { error = false } = {}) => new ReadableStream<Uint8Array>({
  start(c) {
    for (const ch of chunks) c.enqueue(enc.encode(ch));
    if (error) c.error(new Error("upstream broke"));
    else c.close();
  },
}).getReader();

const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

// 收集事件与 return 值；抛错则返回 { error }
async function drain(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  opts?: ParseOptions,
): Promise<{ events: StreamEvent[]; result?: StreamResult; error?: any }> {
  const events: StreamEvent[] = [];
  const gen = parseResponsesEvents(reader, opts);
  try {
    while (true) {
      const { done, value } = await gen.next();
      if (done) return { events, result: value };
      events.push(value);
    }
  } catch (e) {
    return { events, error: e };
  }
}

describe("parseResponsesEvents", () => {
  it("DeepSeek 形态：每帧带 event: 行、无 [DONE]，以 response.completed 收尾并归一化 usage（含 cached_tokens）", async () => {
    const { events, result } = await drain(readerOf([
      "event: response.created\n" + frame({ type: "response.created" }),
      "event: response.output_text.delta\n" + frame({ type: "response.output_text.delta", delta: "你" }),
      "event: response.output_text.delta\n" + frame({ type: "response.output_text.delta", delta: "好" }),
      "event: response.completed\n" + frame({ type: "response.completed", response: { usage: {
        input_tokens: 100, input_tokens_details: { cached_tokens: 64 }, output_tokens: 7,
      } } }),
    ]));
    expect(events).toEqual([{ type: "delta", text: "你" }, { type: "delta", text: "好" }]);
    expect(result).toEqual({ usage: { prompt_tokens: 100, completion_tokens: 7, cached_tokens: 64 } });
  });

  it("cached_tokens 为 0 时 usage 不带该键（非缓存路径形状不变）", async () => {
    const { result } = await drain(readerOf([
      frame({ type: "response.completed", response: { usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1 } } }),
    ]));
    expect(result!.usage).toEqual({ prompt_tokens: 10, completion_tokens: 1 });
  });

  it("注释行、空行、脏 JSON 行都跳过", async () => {
    const { events, result } = await drain(readerOf([
      ": keep-alive\n\n",
      "data: {not json\n\n",
      frame({ type: "response.output_text.delta", delta: "ok" }),
      frame({ type: "response.completed", response: {} }),
    ]));
    expect(events).toEqual([{ type: "delta", text: "ok" }]);
    expect(result).toEqual({ usage: null });
  });

  it("上游未收尾即结束 → 抛错（断流语义）", async () => {
    const { events, error } = await drain(readerOf([frame({ type: "response.output_text.delta", delta: "a" })]));
    expect(events).toEqual([{ type: "delta", text: "a" }]);
    expect(error).toBeTruthy();
  });

  it("response.failed → 抛错", async () => {
    const { error } = await drain(readerOf([frame({ type: "response.failed" })]));
    expect(String(error)).toContain("response.failed");
  });

  it("搜索链路：searching 去重为一条 started，item done 计次并带 query，url_citation 去重为 source；usage 带 search_calls", async () => {
    const { events, result } = await drain(readerOf([
      frame({ type: "response.web_search_call.in_progress", item_id: "ws1" }),
      frame({ type: "response.web_search_call.searching", item_id: "ws1" }),
      frame({ type: "response.output_item.done", item: { type: "web_search_call", action: { query: "kotlin" } } }),
      frame({ type: "response.output_text.annotation.added", annotation: { type: "url_citation", url: "https://a", title: "A" } }),
      frame({ type: "response.output_text.annotation.added", annotation: { type: "url_citation", url: "https://a", title: "A" } }),
      frame({ type: "response.output_text.delta", delta: "x" }),
      frame({ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } }),
    ]));
    expect(events).toEqual([
      { type: "search", state: "started" },
      { type: "search", state: "done", query: "kotlin" },
      { type: "source", title: "A", url: "https://a" },
      { type: "delta", text: "x" },
    ]);
    expect(result!.usage).toEqual({ prompt_tokens: 1, completion_tokens: 1, search_calls: 1 });
  });

  it("旧 Chat Completions 帧仍能解析，[DONE] 收尾", async () => {
    const { events, result } = await drain(readerOf([
      frame({ choices: [{ delta: { content: "He" } }] }),
      frame({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } }),
      "data: [DONE]\n\n",
    ]));
    expect(events).toEqual([{ type: "delta", text: "He" }]);
    expect(result).toEqual({ usage: { prompt_tokens: 3, completion_tokens: 2 } });
  });

  it("收尾后释放 reader 锁", async () => {
    const stream = new ReadableStream({ start(c) { c.enqueue(enc.encode(frame({ type: "response.completed", response: {} }))); c.close(); } });
    const reader = stream.getReader();
    await drain(reader);
    expect(stream.locked).toBe(false);
  });
});

describe("parseResponsesEvents 生图项", () => {
  const imgFrames = [
    frame({ type: "response.image_generation_call.in_progress", item_id: "ig_1" }),
    frame({ type: "response.image_generation_call.generating", item_id: "ig_1" }),
    frame({ type: "response.output_item.done", item: { type: "image_generation_call", status: "completed", result: "QUJD" } }),
    frame({ type: "response.output_text.delta", delta: "done" }),
    frame({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 2 } } }),
  ];

  it("generating 只发一次进度；done 时经 storeGeneratedImage 拿 URL 注入 Markdown delta；usage 带 image_generation_calls", async () => {
    const stored: string[] = [];
    const { events, result } = await drain(readerOf(imgFrames), {
      storeGeneratedImage: async (b64: string) => { stored.push(b64); return "https://x/img.jpg"; },
    });
    expect(stored).toEqual(["QUJD"]);
    expect(events).toEqual([
      { type: "imageGeneration", state: "generating" },
      { type: "imageGeneration", state: "done" },
      { type: "delta", text: "\n\n![](https://x/img.jpg)\n\n" },
      { type: "delta", text: "done" },
    ]);
    expect(result!.usage).toEqual({ prompt_tokens: 10, completion_tokens: 2, image_generation_calls: 1 });
  });

  it("没注入 storeGeneratedImage 却收到生图项 → 按断流抛错（图已花钱但交付不了，不能记 ok）", async () => {
    const { error } = await drain(readerOf(imgFrames));
    expect(error).toBeTruthy();
  });

  it("storeGeneratedImage 失败 → 抛错", async () => {
    const { error } = await drain(readerOf(imgFrames), { storeGeneratedImage: async () => { throw new Error("r2 down"); } });
    expect(error?.message).toBe("r2 down");
  });
});
