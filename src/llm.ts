// 模型调用公共层。线上格式是 Responses API，厂商差异只来自 providers.ts 的注册表。
//
// 契约：
//   流式   → { response }        （原样上游 Response，交 stream-parse 解析）
//   非流式 → { content, usage }
//   失败   → { error, code }     （upstream_error | upstream_timeout | upstream_region_blocked，
//                                 文案不泄露厂商名）

import type { ProviderContext } from "./config.js";
import { PROVIDERS, providerOf, type Provider } from "./providers.js";
import { normalizeUsage, countWebSearchCalls, withSearchCalls, type Usage } from "./usage.js";

export const UPSTREAM_TIMEOUT_MS = 30000; // 流式下只罩到响应头到达（timer 在 fetch resolve 后清除）

export interface ChatMessage {
  role: string;
  content: string | any[];
}

export interface CallChatOptions {
  messages: ChatMessage[];
  model: string;
  maxTokens?: number;
  stream?: boolean;
  retry?: number;
  tools?: unknown[];
  maxToolCalls?: number;
  /** 非流式长文场景 30s 不够用时覆盖 */
  timeoutMs?: number;
}

export type UpstreamErrorCode = "upstream_error" | "upstream_timeout" | "upstream_region_blocked";

export interface UpstreamError {
  error: string;
  code: UpstreamErrorCode;
  response?: undefined;
  content?: undefined;
  usage?: undefined;
}

export type CallChatResult =
  | { response: Response; error?: undefined; code?: undefined; content?: undefined; usage?: undefined }
  | { content: string; usage: Usage | null; error?: undefined; code?: undefined; response?: undefined }
  | UpstreamError;

export interface TranscribeOptions {
  file: Blob;
  filename: string;
  model: string;
  languages?: string[];
  timeoutMs?: number;
}

export type TranscribeResult =
  | { text: string; languages: string[]; usage: any; error?: undefined; code?: undefined }
  | UpstreamError;

// Chat Completions 风格消息 → Responses input items：多模态 parts 类型名不同，
// 不转换上游会 400；纯字符串 content 两边通用，原样透传
function toResponsesInput(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    return {
      role: m.role,
      content: m.content.map((p) => {
        if (p.type === "text") return { type: "input_text", text: p.text };
        if (p.type === "image_url") return { type: "input_image", image_url: p.image_url?.url };
        return p;
      }),
    };
  });
}

// 地区拒绝判别：判定依据是**终端访客的国家**而非我们的出口 IP，重试/换 colo 均无效。
// 独立错误码让客户端能说清「重试无效」。
export function isRegionBlocked(status: number, detail: unknown): boolean {
  return status === 403 && String(detail).includes("unsupported_country_region_territory");
}

/**
 * 直连厂商；OpenAI 吃到 403 时改走非 CF 中转重试一次。
 * 中转必须不在 CF 网内——CF 内部路由发往同在 CF 的 api.openai.com 会透传访客地理。
 * 不按 request.cf.country 分流：受限名单未公开且多变，403 本身就是最准的判定器；
 * 也不按 body 里的地区标记判——大 body 请求被地区拒绝时上游提前断连，403 的 body
 * 可能整个读不到（2026-08-29，多图 chat 全挂）。非地区 403 误回落是无害空转：
 * 中转持同一把 key，同样 403 后交还原始响应，语义不变。
 * 重试安全：403 在响应头阶段返回、流式尚未开始，body 可重用；403 是确定性失败、任务确定未创建。
 * 未配置中转时自动保持直连。注册表 relay:false 的厂商（不在 CF 网内）永不回落。
 */
export async function fetchWithRelayFallback(
  ctx: ProviderContext,
  path: string,
  init: RequestInit,
  provider: Provider = PROVIDERS.openai,
): Promise<Response> {
  const direct = await fetch(`${provider.baseUrl}${path}`, init);
  const relay = ctx.providers.openai?.relay;
  if (!provider.relay || direct.status !== 403 || !relay?.url || !relay?.token) return direct;

  console.error("[openai] direct 403, falling back to relay");
  // 剥掉 Authorization：真 key 只存中转端，Worker 侧不必把它再发一程
  const { Authorization, ...headers } = (init?.headers ?? {}) as Record<string, string>;
  try {
    const relayed = await fetch(`${relay.url}${path}`, {
      ...init,
      headers: { ...headers, "x-relay-token": relay.token },
    });
    if (relayed.ok) return relayed;
    console.error(`[openai] relay failed ${relayed.status}`);
  } catch (e: any) {
    console.error("[openai] relay unreachable:", e?.message || e);
  }
  // 中转不可用时交还原始 403，body 未被消费，调用方仍可读 detail 归类（region_blocked / upstream_error）
  return direct;
}

export async function callChat(
  ctx: ProviderContext,
  { messages, model, maxTokens, stream = false, retry = 0, tools, maxToolCalls, timeoutMs = UPSTREAM_TIMEOUT_MS }: CallChatOptions,
): Promise<CallChatResult> {
  const provider = providerOf(model);
  const apiKey = ctx.providers[provider.id]?.apiKey;
  if (!apiKey) {
    console.error(`[llm] ${provider.id} api key missing for ${model}`);
    return { error: "Upstream error", code: "upstream_error" };
  }
  let last: UpstreamError = { error: "Upstream error", code: "upstream_error" };
  for (let attempt = 0; attempt <= retry; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchWithRelayFallback(ctx, "/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          // 不传 temperature：gpt-5 系推理模型只接受默认值，传 0.7 会 400。
          // 流式 usage 随 response.completed 事件自带，无需 stream_options
          model,
          input: toResponsesInput(messages),
          max_output_tokens: maxTokens,
          // 关 store 会挡住 previous_response_id 与 Logs 排查；不想留存的厂商在 requestDefaults 覆盖
          store: true,
          // hosted 工具（如 web_search）；max_tool_calls 是官方首要成本/时延封顶参数
          ...(tools ? { tools } : {}),
          ...(maxToolCalls != null ? { max_tool_calls: maxToolCalls } : {}),
          ...(stream ? { stream: true } : {}),
          ...provider.requestDefaults,
        }),
        signal: controller.signal,
      }, provider);
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        console.error(`[llm] ${provider.id} upstream error ${res.status}: ${detail.slice(0, 500)}`);
        // 固定前缀便于全文搜索统计（Workers Logs 只留 7 天，长期计数看 usage_events.fail_reason）
        if (isRegionBlocked(res.status, detail)) {
          console.error("[openai] region_blocked");
          return { error: "Region not supported", code: "upstream_region_blocked" };
        }
        last = { error: `Upstream error (${res.status})`, code: "upstream_error" };
        if (res.status !== 429 && res.status < 500) return last; // 4xx 非限流不重试
        continue;
      }
      if (stream) return { response: res };
      const data: any = await res.json();
      // 取**最后一个** message 项：搜索场景 DeepSeek 会先吐旁白 message，末项才是最终答案；
      // OpenAI 恒单项不受影响。reasoning 等其它项类型跳过
      const messageItem = (data?.output ?? []).findLast((o: any) => o.type === "message");
      const content = messageItem?.content?.find((c: any) => c.type === "output_text")?.text;
      if (!content) {
        console.error("[llm] empty completion:", JSON.stringify(data).slice(0, 500));
        return { error: "Empty completion", code: "upstream_error" };
      }
      return { content, usage: withSearchCalls(normalizeUsage(data.usage), countWebSearchCalls(data.output)) };
    } catch (e: any) {
      if (e.name === "AbortError") {
        console.error(`[llm] ${provider.id} timeout after ${timeoutMs}ms`);
        last = { error: "Upstream timeout", code: "upstream_timeout" };
      } else {
        console.error("[llm] fetch failed:", e?.message || e);
        last = { error: "Upstream error", code: "upstream_error" };
      }
    } finally {
      clearTimeout(timer);
    }
  }
  return last;
}

/**
 * 文件转写 → { text, languages, usage } | { error, code }。OpenAI 专有端点，不随模型选厂商。
 * 不设 Content-Type：multipart 的 boundary 由运行时按 FormData 生成。
 * 不重试：音频体已随请求上行，重试等于重传，且转写失败由用户重说更自然。
 */
export async function transcribeAudio(
  ctx: ProviderContext,
  { file, filename, model, languages, timeoutMs = UPSTREAM_TIMEOUT_MS }: TranscribeOptions,
): Promise<TranscribeResult> {
  const form = new FormData();
  form.append("file", file, filename);
  form.append("model", model);
  for (const code of languages ?? []) form.append("languages[]", code);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchWithRelayFallback(ctx, "/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${ctx.providers.openai?.apiKey}` },
      body: form,
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`OpenAI transcribe error ${res.status}: ${detail.slice(0, 500)}`);
      if (isRegionBlocked(res.status, detail)) {
        console.error("[openai] region_blocked");
        return { error: "Region not supported", code: "upstream_region_blocked" };
      }
      return { error: `Upstream error (${res.status})`, code: "upstream_error" };
    }
    const data: any = await res.json();
    if (typeof data?.text !== "string") {
      console.error("OpenAI transcribe malformed:", JSON.stringify(data).slice(0, 500));
      return { error: "Malformed transcription", code: "upstream_error" };
    }
    return {
      text: data.text,
      languages: (data.languages ?? []).map((l: any) => l?.code).filter(Boolean),
      usage: data.usage ?? null,
    };
  } catch (e: any) {
    if (e.name === "AbortError") {
      console.error(`OpenAI transcribe timeout after ${timeoutMs}ms`);
      return { error: "Upstream timeout", code: "upstream_timeout" };
    }
    console.error("OpenAI transcribe fetch failed:", e?.message || e);
    return { error: "Upstream error", code: "upstream_error" };
  } finally {
    clearTimeout(timer);
  }
}
