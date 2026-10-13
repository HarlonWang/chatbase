import type { ChatContext } from "../config.js";
import { methodGuard, requireInstallId, readJsonBody, quotaExceeded, jsonOk, jsonError, todayUTC } from "../http.js";
import { resolveTier } from "../tier.js";
import { runBillingGate, settleUsage, type BillingGate } from "../credits.js";
import { callChat } from "../llm.js";
import { getChatImagesConfig } from "../chat-images.js";
import { upstreamToSSE } from "../sse.js";
import { storeGeneratedImage } from "../generated-images.js";
import { parseChatRequest } from "../chat/request.js";
import { decideChatPolicy } from "../chat/policy.js";
import { buildChatInput } from "../chat/input.js";
import type { Usage } from "../usage.js";

// POST /chat：传输校验 → 请求解析（chat/request）→ 档位 → 策略裁决（chat/policy）
// → 留痕 → 计费闸 → 上游输入（chat/input）→ 调用 → 按模式结算。协议见 docs/chat-protocol.md。

const fail = ({ message, status, code }: { message: string; status: number; code: string }) => jsonError(message, status, code);

// 尽力而为地记录本轮用户问题（产品洞察 + 滥用监测）。旁路统计，绝不影响聊天主流程：写失败只告警。
async function logUserQuestion(ctx: ChatContext, { installId, day, content, lang, hasContext, imageCount }: {
  installId: string; day: string; content: string; lang: string; hasContext: boolean; imageCount: number;
}): Promise<void> {
  try {
    await ctx.db.prepare(
      "INSERT INTO chat_logs (install_id, day, created_at, content, lang, has_context, image_count) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(installId, day, new Date().toISOString(), content, lang, hasContext ? 1 : 0, imageCount).run();
  } catch (e: any) {
    console.error("chat_logs insert failed:", e?.message || e);
  }
}

// 预扣后的结算闭包：ok 回填成本，fail 退还预扣并留 failReason（上游报错 / 客户端断流）
function makeSettler(ctx: ChatContext, gate: Extract<BillingGate, { error?: undefined }>, tier: ResolvedTierValue, feature: string, model: string, day: string) {
  const settle = (ok: boolean, usage: Usage | null, failReason: string | null = null) => settleUsage(ctx, {
    identity: gate.identity, tier, feature, model,
    credits: gate.credits, usage, ok, day, eventId: gate.eventId, failReason,
  });
  return { ok: (usage: Usage | null) => settle(true, usage), fail: (reason: string) => settle(false, null, reason) };
}
type ResolvedTierValue = "anonymous" | "user" | "pro";

export async function handleChat(request: Request, ctx: ChatContext, exec?: Pick<ExecutionContext, "waitUntil">): Promise<Response> {
  const blocked = methodGuard(request, ["POST"]);
  if (blocked) return blocked;
  const { installId, errorResponse: noInstall } = requireInstallId(request);
  if (noInstall) return noInstall;
  const { body, errorResponse: badJson } = await readJsonBody(request);
  if (badJson) return badJson;

  const req = parseChatRequest(body, await getChatImagesConfig(ctx.kv));
  if (req.error) return fail(req.error);

  const tierInfo = await resolveTier(ctx, request);
  if (tierInfo.errorResponse) return tierInfo.errorResponse;
  const { tier, userSub } = tierInfo;

  const policy = decideChatPolicy(req, tier, ctx, { imagesEnabled: ctx.images != null });
  if (policy.error) return fail(policy.error);

  const day = todayUTC();
  const waitUntil = exec ? exec.waitUntil.bind(exec) : null;
  // 留痕在计费闸之前，被限流/上游报错的请求也留下记录；不阻塞主流程
  if (ctx.logging) {
    const logged = logUserQuestion(ctx, {
      installId, day, content: req.lastText, lang: req.lang,
      hasContext: !!(req.context && req.context.title), imageCount: req.imageCount,
    });
    if (waitUntil) waitUntil(logged);
  }

  // 计费闸（账本模型）：全局美元熔断 → 身份（登录=用户主体）→ 懒授予 → 原子预扣
  const gate = await runBillingGate(ctx, {
    installId, userSub, tier, feature: policy.feature, day,
    extraCostMicros: policy.extraCostMicros,
    request, waitUntil,
  });
  if (gate.error) return quotaExceeded(gate.error, tier, gate.resetAt);
  const settle = makeSettler(ctx, gate, tier, policy.feature, policy.model, day);

  // 打点供非流式路径退役决策（线上旧客户端仍打 JSON 模式）
  if (!req.wantStream) console.log("[chat] legacy_json_mode");
  const origin = new URL(request.url).origin;
  const result = await callChat(ctx, { messages: buildChatInput(ctx.prompt, req, origin, ctx.basePath), ...policy.upstream });
  if (result.error) {
    await settle.fail(result.code);
    return jsonError(result.error, 502, result.code);
  }

  if (req.wantStream) {
    // 结算在流正常走完后、done 事件发出前；上游断流走 onAbort 退还预扣。
    // 客户端断开由 waitUntil 兜底读完上游再结算——上游的钱已经在花
    return upstreamToSSE(result.response!, {
      waitUntil: waitUntil ?? undefined,
      storeGeneratedImage: req.wantImageGeneration ? (b64: string) => storeGeneratedImage(ctx, origin, b64) : undefined,
      onComplete: (_fullText: string, usage: Usage | null) => settle.ok(usage),
      onAbort: () => settle.fail("client_abort"),
    });
  }

  await settle.ok(result.usage ?? null);
  return jsonOk({ content: result.content });
}
