// /api/chat 请求体解析与形态校验（纯函数，无 I/O）。
// 产出归一化的请求描述；档位 / 模型 / 能力等策略裁决在 policy.ts，这里只管「请求本身合不合法」。

import type { ChatContextInput } from "../config.js";

export const MAX_CONTENT_LEN = 8000; // 单条 user 消息字符上限（防滥用；assistant 回复由模型生成，不受此闸；总量另由 input.ts 的历史预算兜底）
export const MAX_IMAGE_B64 = 500 * 1024; // 单张 data-url 长度上限（≈500KB base64）
// 只收内嵌 base64 图片；http(s) URL 一律拒绝（防 SSRF/白嫖代理）
const IMAGE_DATA_URL_RE = /^data:image\/(jpeg|png|webp);base64,/;

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: "user" | "assistant";
  content: string | ContentPart[];
}

export interface ImagesConfig {
  maxCount: number;
  maxTotalImageB64: number;
}

export interface ChatRequestError {
  error: { message: string; status: number; code: string };
}

export interface ChatRequest {
  error?: undefined;
  messages: ChatMessage[];
  lastText: string;
  imageCount: number;
  lang: "zh" | "en";
  context: ChatContextInput | null;
  requestedModel: unknown;
  wantStream: boolean;
  wantImageGeneration: boolean;
  wantSearch: boolean;
}

export type ParseChatRequestResult = ChatRequestError | ChatRequest;

interface ParsedContent {
  text: string;
  imageLens: number[];
}

const reject = (message: string, code: string): ChatRequestError => ({ error: { message, status: 400, code } });

// 解析一条消息的 content（string 或 OpenAI 多模态 parts 数组）。
// 合法返回 { text, imageLens }：text 为全部文本部分拼接，imageLens 为各图 data-url 长度；结构非法返回 null。
export function parseContent(content: unknown): ParsedContent | null {
  if (typeof content === "string") return { text: content, imageLens: [] };
  if (!Array.isArray(content) || content.length === 0) return null;
  let text = "";
  const imageLens: number[] = [];
  for (const p of content) {
    if (p && p.type === "text" && typeof p.text === "string") {
      text += p.text;
    } else if (
      p && p.type === "image_url" && typeof p.image_url?.url === "string" &&
      IMAGE_DATA_URL_RE.test(p.image_url.url)
    ) {
      imageLens.push(p.image_url.url.length);
    } else {
      return null;
    }
  }
  return { text, imageLens };
}

/**
 * body → 归一化请求 | { error }。
 * imgCfg 来自 chat-images.ts（KV 可调），只在末条带图时才需要。
 */
export function parseChatRequest(body: unknown, imgCfg: ImagesConfig): ParseChatRequestResult {
  const b = (body ?? {}) as Record<string, unknown>;
  const messages = b.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return reject("messages is required", "invalid_request");
  }
  const parsedByIndex: ParsedContent[] = [];
  for (const m of messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) {
      return reject("Invalid message format", "invalid_message_format");
    }
    // parts 数组是用户发图专用形态；assistant 回复只允许 string
    const parsed = m.role === "user"
      ? parseContent(m.content)
      : (typeof m.content === "string" ? { text: m.content, imageLens: [] } : null);
    if (!parsed) return reject("Invalid message format", "invalid_message_format");
    if (m.role === "user" && parsed.text.length > MAX_CONTENT_LEN) {
      return reject(`Message exceeds ${MAX_CONTENT_LEN} characters`, "content_too_long");
    }
    parsedByIndex.push(parsed);
  }
  if (messages[messages.length - 1].role !== "user") {
    return reject("Last message must be from user", "last_must_be_user");
  }

  // 图片只允许出现在末条 user 消息：历史轮由客户端降级为占位文本，不重传 base64
  if (parsedByIndex.slice(0, -1).some((p) => p.imageLens.length > 0)) {
    return reject("Images allowed only in the latest message", "images_in_history");
  }
  const last = parsedByIndex[parsedByIndex.length - 1];
  const imageLens = last.imageLens;
  if (imageLens.length > 0) {
    if (imageLens.length > imgCfg.maxCount) {
      return reject(`At most ${imgCfg.maxCount} images per message`, "too_many_images");
    }
    if (imageLens.some((n) => n > MAX_IMAGE_B64)) return reject("Image too large", "image_too_large");
    if (imageLens.reduce((a, b) => a + b, 0) > imgCfg.maxTotalImageB64) {
      return reject("Total image size too large", "images_too_large");
    }
  }

  const wantImageGeneration = b.imageGeneration === true;
  return {
    messages: messages as ChatMessage[],
    lastText: last.text,
    imageCount: imageLens.length,
    lang: b.lang === "zh" ? "zh" : "en", // 仅显式 zh 用中文，其余默认英文
    context: (b.context as ChatContextInput | undefined) || null,
    requestedModel: b.model,
    wantStream: b.stream === true,
    wantImageGeneration,
    // 生图与搜索互斥：max_tool_calls 是全部 hosted 工具的总上限，两者并存就封不住「最多一张图」；
    // 生图优先，本条消息忽略搜索（客户端两个开关也做成互斥，这里兜旧客户端）
    wantSearch: b.search === true && !wantImageGeneration,
  };
}
