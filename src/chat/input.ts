// /api/chat 上游输入组装（纯函数）：系统提示、历史裁剪、生图跟进的参考图。

import type { ChatContextInput, PromptConfig } from "../config.js";
import { generatedImageKeyFromUrl } from "../generated-images.js";
import type { ChatMessage, ChatRequest, ContentPart } from "./request.js";

export type Lang = "zh" | "en";

export interface PromptFlags {
  imageGeneration?: boolean;
  search?: boolean;
}

export interface UpstreamMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

export const MAX_TURNS = 12; // 发往上游的最近消息条数
export const MAX_HISTORY_CHARS = 16000; // 历史总字符预算（超则丢最旧）；16k 保证 ~5.5k 字符的详细解读
                                        // 在多轮追问中存活（解读随 messages 带上来，服务端不查库）

// 搜索开启时的引用指示：官方合规要求 inline citation 对用户可见可点——
// 要求模型正文直接内联 markdown 链接，annotations 的 source 事件作为补充来源行
function searchGuidance(lang: Lang): string {
  return lang === "zh"
    ? "\n检索到网络信息时，关键事实需在正文内联引用来源（markdown 链接格式），不要在结尾单独罗列来源清单。"
    : "\nWhen citing web results, cite sources inline as clickable markdown links in the text; do not append a separate source list at the end.";
}

// 「能不能出图」按本次请求是否挂了 image_generation 工具二选一：没挂时首句明确拒绝；
// 挂了时禁止模型在正文写图片占位——图片由服务端存图后以 Markdown 注入
const IMAGE_GENERATION_PROMPT = {
  en: {
    off: " You can read images the user sends, but you cannot generate, draw, or edit images. " +
      "If the user asks you to create or edit an image, say so plainly in your first sentence; " +
      "do not substitute a text description, and do not suggest signing in or uploading an " +
      "image to try again. You may point them to a dedicated image generation tool.",
    on: " You can generate or edit images with the image_generation tool. Use it only when the " +
      "user clearly asks for an image; when they do, call it rather than describing the image " +
      "in words. The generated image is shown to the user automatically — never write an " +
      "image placeholder or link in your text. Keep any accompanying text brief.",
  },
  zh: {
    off: "你可以阅读用户发来的图片，但不能生成、绘制或修改图片。" +
      "若用户要求生成或编辑图片，请在回复第一句直接说明不支持，不要用文字描述代替，" +
      "也不要建议用户登录或上传图片再试；可以建议使用专门的图片生成工具。",
    on: "你可以用 image_generation 工具生成或编辑图片。只在用户明确要图时调用；" +
      "要图时直接调用工具，不要用文字描述代替。生成的图片会自动展示给用户——" +
      "正文里不要写任何图片占位符或链接，配文尽量简短。",
  },
};

/** 把请求体 context 渲染为「用户正在查看以下条目」附加段；无 title 返回空串 */
export function renderItemContext(lang: Lang, context: ChatContextInput): string {
  if (!context || !context.title) return "";
  const L = lang === "en"
    ? { intro: "The user is viewing the following item:", t: "Title", s: "Summary", u: "Source", tail: "Answer based on this item first." }
    : { intro: "用户正在查看以下条目：", t: "标题", s: "摘要", u: "来源", tail: "请优先基于该条目作答。" };
  const lines = [`\n\n${L.intro}`, `${L.t}: ${context.title}`];
  if (context.summary) lines.push(`${L.s}: ${context.summary}`);
  if (context.sourceUrl) lines.push(`${L.u}: ${context.sourceUrl}`);
  lines.push(L.tail);
  return lines.join("\n");
}

export function buildSystemPrompt(
  prompt: PromptConfig,
  lang: Lang,
  context: ChatContextInput | null | undefined,
  { imageGeneration = false, search = false }: PromptFlags = {},
): string {
  if (prompt.system) return prompt.system(lang, { imageGeneration, search });

  const imageGenerationPrompt = IMAGE_GENERATION_PROMPT[lang === "en" ? "en" : "zh"][imageGeneration ? "on" : "off"];
  let base: string;
  if (lang === "en") {
    base = `You are ${prompt.brand}'s AI assistant. Format answers in Markdown. Reply in ` +
      "English by default; if the user clearly writes in another language, follow the " +
      "user's language." + imageGenerationPrompt;
  } else {
    base = `你是 ${prompt.brand} 的 AI 助手，使用 Markdown 排版。` +
      "默认用简洁中文回答；若用户明显使用其他语言，则跟随用户的语言。" + imageGenerationPrompt;
  }

  if (prompt.context && context) base += prompt.context(lang, context);
  if (search) base += searchGuidance(lang);
  return base;
}

// 历史预算只按文本计；图片体积由 request.ts 单独限制
function contentTextLen(content: string | ContentPart[]): number {
  return typeof content === "string"
    ? content.length
    : content.reduce((n, p) => n + (p.type === "text" ? p.text.length : 0), 0);
}

// 取最近 MAX_TURNS 条，并在总字符超预算时从最旧端丢弃；末条永远保留
export function trimHistory<T extends ChatMessage>(messages: T[]): T[] {
  let recent = messages.slice(-MAX_TURNS);
  let total = recent.reduce((n, m) => n + contentTextLen(m.content), 0);
  while (recent.length > 1 && total > MAX_HISTORY_CHARS) {
    total -= contentTextLen(recent[0].content);
    recent = recent.slice(1);
  }
  return recent;
}

// 生图开启时把历史里最近一张我们生成的图带回上下文，让「换个背景」这类跟进能编辑它。
// 只认本服务签发的 URL（防拿任意外链当参考图）；客户端历史里的 assistant 内容是纯文本 Markdown
const GENERATED_IMAGE_RE = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g;
function lastGeneratedImageUrl(messages: ChatMessage[], origin: string, basePath: string): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant" || typeof m.content !== "string") continue;
    let last: string | null = null;
    for (const match of m.content.matchAll(GENERATED_IMAGE_RE)) {
      if (generatedImageKeyFromUrl(match[1], origin, basePath)) last = match[1];
    }
    if (last) return last;
  }
  return null;
}

// 末条 user 消息追加一张参考图（string content 先升格为 parts）
function withReferenceImage(messages: ChatMessage[], url: string): ChatMessage[] {
  const lastIdx = messages.length - 1;
  const last = messages[lastIdx];
  const parts: ContentPart[] = typeof last.content === "string"
    ? [{ type: "text", text: last.content }]
    : last.content.slice();
  parts.push({ type: "image_url", image_url: { url } });
  return [...messages.slice(0, lastIdx), { ...last, content: parts }];
}

/** (prompt 配置, 请求, 本服务 origin) → 发往上游的 messages（system 在前） */
export function buildChatInput(prompt: PromptConfig, req: ChatRequest, origin: string, basePath = "/api"): UpstreamMessage[] {
  let history: ChatMessage[] = trimHistory(req.messages).map((m) => ({ role: m.role, content: m.content }));
  if (req.wantImageGeneration && req.imageCount === 0) {
    const prev = lastGeneratedImageUrl(history, origin, basePath);
    if (prev) history = withReferenceImage(history, prev);
  }
  const system = buildSystemPrompt(prompt, req.lang, req.context, { imageGeneration: req.wantImageGeneration, search: req.wantSearch });
  return [{ role: "system", content: system }, ...history];
}
