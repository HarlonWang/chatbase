// 语音录入参数单源：KV 的 chat_voice（JSON，如 {"max_duration_ms":60000}）。
// 校验闸与客户端下发同读——改 KV 即时生效、无需部署；未配置/解析失败回落默认。
// 体积上限不下发：客户端按时长封顶即天然受控，60s 的 16kHz 单声道 AAC 约 240KB，2MB 是服务端兜底而非产品参数。

export const CHAT_VOICE_DEFAULTS = { maxDurationMs: 60_000 };
export const CHAT_VOICE_MAX_BYTES = 2 * 1024 * 1024;

export const TRANSCRIBE_MODEL = "gpt-transcribe";
// 官方估价 $0.0045 / 分钟（developers.openai.com/api/docs/pricing → Transcription models）；
// 该模型按分钟标价、不公开 token 单价，故成本按时长折算而非 token 牌价表
export const TRANSCRIBE_MICROS_PER_SECOND = 75;

export interface ChatVoiceConfig {
  maxDurationMs: number;
  maxBytes: number;
}

function positiveInt(v: unknown, fallback: number): number {
  return Number.isInteger(v) && (v as number) > 0 ? (v as number) : fallback;
}

export async function getChatVoiceConfig(kv: KVNamespace | null): Promise<ChatVoiceConfig> {
  let cfg: any = null;
  try {
    const raw = await kv?.get("chat_voice");
    if (raw) cfg = JSON.parse(raw);
  } catch {
    /* 格式配错按未配置处理 */
  }
  return {
    maxDurationMs: positiveInt(cfg?.max_duration_ms, CHAT_VOICE_DEFAULTS.maxDurationMs),
    maxBytes: CHAT_VOICE_MAX_BYTES,
  };
}

/** 转写成本（微美元）：优先上游 usage 的秒数，缺则用客户端上报时长。 */
export function transcribeCostMicros(usage: any, durationMs: number): number {
  const seconds = usage?.type === "duration" && Number.isFinite(usage.seconds)
    ? usage.seconds
    : durationMs / 1000;
  return Math.ceil(Math.max(seconds, 0) * TRANSCRIBE_MICROS_PER_SECOND);
}
