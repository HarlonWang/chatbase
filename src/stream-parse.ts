// 上游流 → 统一事件。sse.ts 只认这里产出的事件，接新厂商协议只需再写一个 parse* 生成器。
// 生成图不单独成事件：存图后以 Markdown 图片作为 delta 下发，客户端渲染零改动。
// 收尾：生成器 return { usage }；上游异常或未收尾即结束则 throw——调用方据此区分「完整走完」与「断流」。

import { normalizeUsage, withSearchCalls, withImageGenerationCalls, type Usage } from "./usage.js";

export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "search"; state: "started" | "done"; query?: string }
  | { type: "source"; title: string; url: string }
  | { type: "imageGeneration"; state: "generating" | "done" };

export interface StreamResult {
  usage: Usage | null;
}

export interface ParseOptions {
  /** base64 JPEG → 可公开访问的 URL；非生图路径不注入 */
  storeGeneratedImage?: (base64: string) => Promise<string>;
}

/** 上游 SSE 的 data 行 → 逐条 JSON（容忍脏行、跨 chunk 拆分）；[DONE] 以 null 表示 */
async function* dataLines(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<any, void, undefined> {
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith("data:")) continue; // event:/注释/空行都跳过
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") {
        yield null;
        continue;
      }
      try {
        yield JSON.parse(payload);
      } catch {
        // 容忍上游偶发脏行
      }
    }
  }
}

/**
 * Responses API 流（OpenAI / DeepSeek 同构）→ 统一事件。
 * 收尾判定：response.completed / response.incomplete（触 max_output_tokens 截断，已生成内容照常交付）；
 * DeepSeek 不发 [DONE]，OpenAI 的 [DONE] 在 completed 之后，两者都以 completed 为准。
 * 旧 Chat Completions 帧（choices/[DONE]）保留兼容：回退老接口时本层无需改动。
 */
export async function* parseResponsesEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  { storeGeneratedImage }: ParseOptions = {},
): AsyncGenerator<StreamEvent, StreamResult, undefined> {
  let usage: Usage | null = null;
  let searchCalls = 0; // 完成的 web_search_call 数——按次费的计费依据
  let imageGenerationCalls = 0; // 完成的 image_generation_call 数——按张费的计费依据
  const searchStarted = new Set<string>(); // web_search_call item_id 去重（started 每次调用只发一条）
  const imageGenerationStarted = new Set<string>();
  const seenSourceUrls = new Set<string>(); // url_citation 按 url 去重
  const finish = (): StreamResult => ({
    usage: withImageGenerationCalls(withSearchCalls(usage, searchCalls), imageGenerationCalls),
  });
  try {
    for await (const data of dataLines(reader)) {
      if (data === null) return finish(); // 旧接口 [DONE]
      if (data.type === "response.output_text.delta") {
        if (data.delta) yield { type: "delta", text: data.delta };
        continue;
      }
      if (data.type === "response.completed" || data.type === "response.incomplete") {
        usage = normalizeUsage(data.response?.usage) ?? usage;
        return finish();
      }
      if (data.type === "response.failed" || data.type === "error") {
        throw new Error(`upstream terminal failure: ${data.type}`);
      }
      if (
        data.type === "response.web_search_call.searching" ||
        data.type === "response.web_search_call.in_progress"
      ) {
        const itemId: string = data.item_id ?? "ws";
        if (!searchStarted.has(itemId)) {
          searchStarted.add(itemId);
          yield { type: "search", state: "started" };
        }
        continue;
      }
      if (data.type === "response.output_item.done" && data.item?.type === "web_search_call") {
        searchCalls++;
        const query: string | undefined = data.item.action?.query;
        yield query ? { type: "search", state: "done", query } : { type: "search", state: "done" };
        continue;
      }
      if (
        data.type === "response.image_generation_call.generating" ||
        data.type === "response.image_generation_call.in_progress"
      ) {
        const itemId: string = data.item_id ?? "ig";
        if (!imageGenerationStarted.has(itemId)) {
          imageGenerationStarted.add(itemId);
          yield { type: "imageGeneration", state: "generating" };
        }
        continue;
      }
      if (data.type === "response.output_item.done" && data.item?.type === "image_generation_call") {
        // 未注入 storeGeneratedImage（非生图路径）不可能收到此项；收到即存图并以 Markdown 下发。
        // 存图失败按断流处理：图已生成、钱已花，但用户什么都没拿到，不能记 ok
        if (!data.item.result || !storeGeneratedImage) throw new Error("image_generation_call without result or store");
        const url = await storeGeneratedImage(data.item.result);
        imageGenerationCalls++;
        yield { type: "imageGeneration", state: "done" };
        yield { type: "delta", text: `\n\n![](${url})\n\n` };
        continue;
      }
      if (
        data.type === "response.output_text.annotation.added" &&
        data.annotation?.type === "url_citation"
      ) {
        const { url, title } = data.annotation as { url?: string; title?: string };
        if (url && !seenSourceUrls.has(url)) {
          seenSourceUrls.add(url);
          yield { type: "source", title: title ?? url, url };
        }
        continue;
      }
      if (data.type) continue; // 其它语义事件本层不转发
      // 旧 Chat Completions 帧
      if (data.usage) usage = data.usage;
      const delta = data.choices?.[0]?.delta?.content;
      if (delta) yield { type: "delta", text: delta };
    }
    // 上游没走到收尾就结束：按断流处理，让客户端走可重试路径
    throw new Error("upstream ended without completion");
  } finally {
    reader.releaseLock();
  }
}
