import type { ChatContext } from "../config.js";
import { methodGuard, requireInstallId, jsonNoStore, todayUTC } from "../http.js";
import { resolveTier } from "../tier.js";
import { resolveIdentity, ensureDailyGrant, nextGrantAtUTC } from "../credits.js";

// GET /quota：余额可见性接口。客户端能查「还剩多少、何时重置」，撞墙时刻才不是「用着用着突然 429」。
// 顺带完成当日懒授予：查询本身就把「今天的额度」入账，客户端首屏拉一次即可见真实余额。
export async function handleQuota(request: Request, ctx: ChatContext): Promise<Response> {
  const blocked = methodGuard(request, ["GET"]);
  if (blocked) return blocked;

  const { installId, errorResponse: noInstall } = requireInstallId(request);
  if (noInstall) return noInstall;

  const tierInfo = await resolveTier(ctx, request);
  if (tierInfo.errorResponse) return tierInfo.errorResponse;
  const { tier, userSub } = tierInfo;

  const day = todayUTC();
  let identity = await resolveIdentity(ctx, { installId, userSub });
  identity = await ensureDailyGrant(ctx, identity, tier, day);

  // 余额是每次请求都在变的个人数据：禁缓存
  return jsonNoStore({
    balance: identity.balance,
    dailyGrant: ctx.credits.dailyGrant[tier] ?? ctx.credits.dailyGrant.anonymous,
    resetAt: nextGrantAtUTC(day),
    tier,
  });
}
