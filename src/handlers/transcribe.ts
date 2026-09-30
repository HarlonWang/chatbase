import type { ChatContext } from "../config.js";
import { methodGuard, requireInstallId, quotaExceeded, jsonOk, jsonError, todayUTC } from "../http.js";
import { resolveTier } from "../tier.js";
import { runBillingGate, settleUsage } from "../credits.js";
import { transcribeAudio } from "../llm.js";
import { getChatVoiceConfig, transcribeCostMicros, TRANSCRIBE_MODEL } from "../chat-voice.js";

// 语音录入 = 两段式的转写段：收音频、只吐文本，文本再由客户端经 /chat 正常发送。
// 音频不落库、不进 chat_logs（转写文本随后在 /chat 留痕）。

const FEATURE = "chat_voice";

// 中英夹杂是主场景：主语言在前作为提示，另一种兜底
function languageHints(lang: string): string[] {
  return lang === "zh" ? ["zh-cn", "en"] : ["en", "zh-cn"];
}

export async function handleChatTranscribe(request: Request, ctx: ChatContext, exec?: Pick<ExecutionContext, "waitUntil">): Promise<Response> {
  const blocked = methodGuard(request, ["POST"]);
  if (blocked) return blocked;

  const { installId, errorResponse: noInstall } = requireInstallId(request);
  if (noInstall) return noInstall;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError("Expected multipart form data", 400, "invalid_request");
  }
  const file = form.get("file");
  if (!(file instanceof Blob) || file.size === 0) {
    return jsonError("Audio file is required", 400, "audio_empty");
  }
  const durationMs = Number(form.get("duration_ms"));
  if (!Number.isInteger(durationMs) || durationMs <= 0) {
    return jsonError("duration_ms is required", 400, "invalid_request");
  }

  const cfg = await getChatVoiceConfig(ctx.kv);
  if (file.size > cfg.maxBytes) return jsonError("Audio too large", 400, "audio_too_large");
  if (durationMs > cfg.maxDurationMs) return jsonError("Audio too long", 400, "audio_too_long");

  const lang = form.get("lang") === "zh" ? "zh" : "en";
  const day = todayUTC();

  const tierInfo = await resolveTier(ctx, request);
  if (tierInfo.errorResponse) return tierInfo.errorResponse;
  const { tier, userSub } = tierInfo;
  // 客户端隐藏入口只是体验层，这里是真闸
  if (tier !== "pro") return jsonError("Voice input requires Pro", 403, "voice_requires_pro");

  const gate = await runBillingGate(ctx, {
    installId, userSub, tier, feature: FEATURE, day,
    request, waitUntil: exec ? exec.waitUntil.bind(exec) : null,
  });
  if (gate.error) return quotaExceeded(gate.error, tier, gate.resetAt);

  const result = await transcribeAudio(ctx, {
    file,
    filename: typeof (file as File).name === "string" && (file as File).name ? (file as File).name : "voice.m4a",
    model: TRANSCRIBE_MODEL,
    languages: languageHints(lang),
  });
  const settle = (ok: boolean, usage: any, failReason: string | null = null, costMicros: number | null = null) => settleUsage(ctx, {
    identity: gate.identity, tier, feature: FEATURE, model: TRANSCRIBE_MODEL,
    credits: gate.credits, usage, ok, day, eventId: gate.eventId, failReason, costMicros,
  });
  if (result.error !== undefined) {
    await settle(false, null, result.code);
    return jsonError(result.error, 502, result.code);
  }

  // 账本的 tokens 列只在上游给 tokens 型 usage 时有值；成本一律按时长折算
  const usage = result.usage?.type === "tokens"
    ? { prompt_tokens: result.usage.input_tokens ?? 0, completion_tokens: result.usage.output_tokens ?? 0 }
    : null;
  await settle(true, usage, null, transcribeCostMicros(result.usage, durationMs));

  return jsonOk({ text: result.text.trim(), languages: result.languages }, 0);
}
