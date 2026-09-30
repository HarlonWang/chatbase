import { CORS_HEADERS } from "./http.js";
import { parseResponsesEvents, type ParseOptions, type StreamEvent, type StreamResult } from "./stream-parse.js";
import type { Usage } from "./usage.js";

// 客户端 SSE 层。事件协议是与客户端 SDK 的契约，见 docs/chat-protocol.md：
//   data: {"delta":"..."}   增量
//   data: {"search":{...}}  搜索进度
//   data: {"source":{...}}  引用来源
//   data: {"imageGeneration":{...}}   生图进度（图片本身走 delta 里的 Markdown）
//   data: {"done":true}     正常收尾（可带元信息）
// 错误不进流：429/4xx/5xx 在流开始前以普通 JSON 返回；流开始后的上游断流以流中断呈现，客户端按可重试处理。

export const SSE_HEADERS: Record<string, string> = {
  ...CORS_HEADERS,
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
};

export interface SSEOptions {
  /** 仅在生成器正常 return 时调用，并在 done 事件发出前 await */
  onComplete?: (fullText: string, usage: Usage | null) => void | Promise<void>;
  /** 生成器抛错时调用（onComplete 已执行则不再调）；与 onComplete 恰好一个会被调用 */
  onAbort?: () => void | Promise<void>;
  /** Workers 的 ctx.waitUntil：传入后客户端断开转后台继续读完上游 */
  waitUntil?: (p: Promise<unknown>) => void;
  /** 客户端断开且未传 waitUntil 时取消上游读取 */
  cancel?: () => void;
}

const enc = new TextEncoder();

const event = (obj: unknown): Uint8Array => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);

/** 全文一次性推完（缓存命中场景），与增量流同一事件格式——客户端单一解析路径 */
export function sseOneShot(text: string, meta: Record<string, unknown> = {}): Response {
  const body = new Uint8Array([...event({ delta: text }), ...event({ done: true, ...meta })]);
  return new Response(body, { headers: SSE_HEADERS });
}

// 统一事件 → 客户端 SSE 帧
function toFrame(ev: StreamEvent): Record<string, unknown> | null {
  if (ev.type === "delta") return { delta: ev.text };
  if (ev.type === "search") return { search: ev.query ? { state: ev.state, query: ev.query } : { state: ev.state } };
  if (ev.type === "source") return { source: { title: ev.title, url: ev.url } };
  if (ev.type === "imageGeneration") return { imageGeneration: { state: ev.state } };
  return null;
}

// 统一事件流（stream-parse.ts 的生成器）→ 客户端 SSE 转发。
// 「完整走完才计」：中途断流则不发 done 也不调 onComplete（不计数、不写缓存）。
// 客户端断开的分支：
//   - 传入 waitUntil 时，断开后转后台继续读完上游再调 onComplete——
//     上游的钱已经在花，读完落缓存让下个人免费命中；
//   - 未传时断开即 cancel() 取消上游读取，不调 onComplete。
export function eventsToSSE(
  events: AsyncIterable<StreamEvent> | AsyncGenerator<StreamEvent, StreamResult, undefined>,
  { onComplete, onAbort, waitUntil, cancel }: SSEOptions = {},
): Response {
  let clientGone = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // 客户端断开后 enqueue 会抛：置位后，有 waitUntil 则静默丢弃（后台续读），
      // 否则向上抛中止 relay，走 catch 收尾
      const send = (obj: unknown): void => {
        if (!clientGone) {
          try {
            controller.enqueue(event(obj));
            return;
          } catch {
            clientGone = true;
          }
        }
        if (!waitUntil) throw new Error("client disconnected");
      };

      const relay = (async () => {
        let fullText = "";
        let settled = false;
        try {
          let result: StreamResult | undefined;
          const it = events[Symbol.asyncIterator]() as AsyncIterator<StreamEvent, StreamResult | undefined, undefined>;
          while (true) {
            const { done, value } = await it.next();
            if (done) {
              result = value;
              break;
            }
            if (value.type === "delta") fullText += value.text;
            const frame = toFrame(value);
            if (frame) send(frame);
          }
          if (onComplete) await onComplete(fullText, result?.usage ?? null);
          settled = true;
          send({ done: true });
          if (!clientGone) controller.close();
        } catch (e: any) {
          console.error("SSE relay aborted:", e?.message || e);
          // onComplete 已跑完才异常（如 done 事件 enqueue 失败）→ 不能再退款
          if (!settled && onAbort) {
            try {
              await onAbort();
            } catch (abortErr: any) {
              console.error("SSE onAbort failed:", abortErr?.message || abortErr);
            }
          }
          // 规范上非 readable 状态应为 no-op，实现上可能抛，包一层更稳
          try {
            controller.error(e);
          } catch {
            /* 客户端已断开 */
          }
        }
      })();

      // 后台续读的执行权由 waitUntil 兜底；未传时响应流结束后执行环境即可回收
      if (waitUntil) waitUntil(relay);
    },
    cancel() {
      clientGone = true;
      if (!waitUntil && cancel) cancel();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

/** Responses API 上游 Response → 客户端 SSE（eventsToSSE 的便捷封装） */
export function upstreamToSSE(
  upstream: Response,
  { storeGeneratedImage, ...opts }: SSEOptions & ParseOptions = {},
): Response {
  const reader = upstream.body!.getReader();
  return eventsToSSE(parseResponsesEvents(reader, { storeGeneratedImage }), {
    ...opts,
    cancel: () => reader.cancel().catch(() => {}),
  });
}
