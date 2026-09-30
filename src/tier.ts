import type { ChatContext, Tier } from "./config.js";
import { jsonError } from "./http.js";

export interface ResolvedTier {
  tier: Tier;
  /** 登录后的账本用户主体键；匿名为 null */
  userSub: string | null;
  errorResponse?: undefined;
}

/** 宿主档位裁决的统一入口：authInvalid → 401；宿主抛错 → 500，不降级放行 */
export async function resolveTier(ctx: ChatContext, request: Request): Promise<ResolvedTier | { errorResponse: Response }> {
  let info;
  try {
    info = await ctx.resolveTier(request);
  } catch (e: any) {
    console.error("[chatbase] resolveTier threw:", e?.message || e);
    return { errorResponse: jsonError("Internal error", 500, "internal") };
  }
  if ("authInvalid" in info) return { errorResponse: jsonError("Invalid or expired token", 401, "auth_invalid") };
  if (info.tier === "anonymous") return { tier: "anonymous", userSub: null };
  return { tier: info.tier, userSub: info.userSub };
}
