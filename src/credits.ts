// 计费「账本 + 授予」双层模型。balance 是缓存列，真相 = Σcredit_grants − Σusage_events；本模块是唯一写入方。

import type { ChatContext, Tier } from "./config.js";
import { priceOf, providerOf, type ModelPrice } from "./providers.js";
import type { Usage } from "./usage.js";

// 模型牌价登记在 providers.ts 各厂商的 prices 段（微美元 / 1M tokens）；cachedInPerM 是缓存命中 input 的价，缺省按 inPerM 全价。
// 新模型不登记也能上架（准入不看牌价），但会按 DEFAULT_PRICE 计成本：
// 取远高于在售旗舰的价，未知模型宁可早熔断，也不低估成本
const DEFAULT_PRICE: ModelPrice = { inPerM: 30_000_000, outPerM: 150_000_000 }; // $30 / $150

/** identities 行 */
export interface Identity {
  id: number;
  install_id: string | null;
  user_sub: string | null;
  balance: number;
  last_grant_day: string | null;
  last_grant_tier: string | null;
}

export type FailReason =
  | "upstream_error"
  | "upstream_timeout"
  | "upstream_region_blocked"
  | "client_abort"
  | "reclaimed"
  | "unknown"
  | (string & {});

export type UsageStatus = "pending" | "ok" | "aborted";

/** runBillingGate 返回：放行带 identity / credits / eventId，拦截带 error / resetAt */
export type BillingGate =
  | { error: "quota_global" | "quota_device"; resetAt: string; identity?: undefined; credits?: undefined; eventId?: undefined }
  | { error?: undefined; resetAt?: undefined; identity: Identity; credits: number; eventId: number | null };

const IDENTITY_COLS = "id, install_id, user_sub, balance, last_grant_day, last_grant_tier";

// 身份解析：登录=用户主体（user_sub 键），匿名=设备主体（install_id 键且 user_sub IS NULL）。
// 登录但仅有设备主体时执行「升级」：写入 user_sub 并清空 last_grant_day——
// 下一次 ensureDailyGrant 会按新档位重授，匿名期余额随之作废（SET 语义）。
export async function resolveIdentity(
  ctx: ChatContext,
  { installId, userSub }: { installId: string; userSub?: string | null },
): Promise<Identity> {
  if (userSub) {
    const byUser = await ctx.db.prepare(
      `SELECT ${IDENTITY_COLS} FROM identities WHERE user_sub = ?`,
    ).bind(userSub).first<Identity>();
    if (byUser) return byUser;

    const byDevice = await ctx.db.prepare(
      `SELECT ${IDENTITY_COLS} FROM identities WHERE install_id = ? AND user_sub IS NULL`,
    ).bind(installId).first<Identity>();
    if (byDevice) {
      // AND user_sub IS NULL 守卫：并发升级只有一个赢家，避免同日双重授予、账本对不上
      const result = await ctx.db.prepare(
        "UPDATE identities SET user_sub = ?, last_grant_day = NULL WHERE id = ? AND user_sub IS NULL",
      ).bind(userSub, byDevice.id).run();
      if ((result?.meta?.changes ?? 0) === 0) {
        // 竞争落败：以库内用户主体行为准
        return (await ctx.db.prepare(
          `SELECT ${IDENTITY_COLS} FROM identities WHERE user_sub = ?`,
        ).bind(userSub).first<Identity>())!;
      }
      return { ...byDevice, user_sub: userSub, last_grant_day: null };
    }

    try {
      return (await ctx.db.prepare(
        `INSERT INTO identities (install_id, user_sub) VALUES (?, ?) RETURNING ${IDENTITY_COLS}`,
      ).bind(installId, userSub).first<Identity>())!;
    } catch {
      // 并发首请求同时建行：落败方撞唯一索引，重读胜者写入的行
      return (await ctx.db.prepare(
        `SELECT ${IDENTITY_COLS} FROM identities WHERE user_sub = ?`,
      ).bind(userSub).first<Identity>())!;
    }
  }

  const byDevice = await ctx.db.prepare(
    `SELECT ${IDENTITY_COLS} FROM identities WHERE install_id = ? AND user_sub IS NULL`,
  ).bind(installId).first<Identity>();
  if (byDevice) return byDevice;

  try {
    return (await ctx.db.prepare(
      `INSERT INTO identities (install_id, user_sub) VALUES (?, NULL) RETURNING ${IDENTITY_COLS}`,
    ).bind(installId).first<Identity>())!;
  } catch {
    // 同上：撞唯一索引则重读胜者写入的行
    return (await ctx.db.prepare(
      `SELECT ${IDENTITY_COLS} FROM identities WHERE install_id = ? AND user_sub IS NULL`,
    ).bind(installId).first<Identity>())!;
  }
}

// 懒授予：当日首次请求时入账。不结转语义 = balance SET 为授予额（昨日余额作废），
// 条件更新（last_grant_day 不等于今日才生效）保证并发下同日只授一次；
// 竞争落败方重读余额为准，不重复落 grant 行。
export async function ensureDailyGrant(ctx: ChatContext, identity: Identity, tier: Tier, day: string): Promise<Identity> {
  // 同日且档位未变才短路——当日升 Pro 要立即按新档重授，否则刚付费即撞墙
  if (identity.last_grant_day === day && identity.last_grant_tier === tier) return identity;

  const amount = ctx.credits.dailyGrant[tier] ?? ctx.credits.dailyGrant.anonymous;
  const result = await ctx.db.prepare(
    "UPDATE identities SET balance = ?, last_grant_day = ?, last_grant_tier = ? " +
    "WHERE id = ? AND (last_grant_day IS NULL OR last_grant_day <> ? OR last_grant_tier IS NOT ?)",
  ).bind(amount, day, tier, identity.id, day, tier).run();

  if ((result?.meta?.changes ?? 0) === 0) {
    // 并发下另一请求已授予：以库内状态为准
    return (await ctx.db.prepare(
      `SELECT ${IDENTITY_COLS} FROM identities WHERE id = ?`,
    ).bind(identity.id).first<Identity>())!;
  }

  await ctx.db.prepare(
    "INSERT INTO credit_grants (identity_id, amount, reason, day) VALUES (?, ?, ?, ?)",
  ).bind(identity.id, amount, `daily_${tier}`, day).run();

  return { ...identity, balance: amount, last_grant_day: day, last_grant_tier: tier };
}

// 原子扣减：检查与扣减在同一条件语句里完成，read-then-write 的并发超发在此根治
export async function chargeCredits(ctx: ChatContext, identityId: number, credits: number): Promise<boolean> {
  const result = await ctx.db.prepare(
    "UPDATE identities SET balance = balance - ? WHERE id = ? AND balance >= ?",
  ).bind(credits, identityId, credits).run();
  return (result?.meta?.changes ?? 0) > 0;
}

// 上游失败时退还预扣（配套 status='aborted' 的事件行，留痕不计费）
export async function refundCredits(ctx: ChatContext, identityId: number, credits: number): Promise<void> {
  await ctx.db.prepare(
    "UPDATE identities SET balance = balance + ? WHERE id = ?",
  ).bind(credits, identityId).run();
}

export interface RecordEventInput {
  identityId: number;
  tier: Tier;
  feature: string;
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  credits: number;
  trueCostMicros: number;
  status: UsageStatus;
  day: string;
  failReason?: FailReason | null;
}

// 出账明细：审计/对账/成本分析的唯一数据源。failReason 只在 status='aborted' 时有意义，
// 用于分出「上游报错」与「用户主动断流」。
export async function recordEvent(
  ctx: ChatContext,
  { identityId, tier, feature, model, tokensIn, tokensOut, credits, trueCostMicros, status, day, failReason = null }: RecordEventInput,
): Promise<void> {
  await ctx.db.prepare(
    "INSERT INTO usage_events (identity_id, tier, feature, model, tokens_in, tokens_out, credits, true_cost_micros, status, day, fail_reason) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(identityId, tier, feature, model, tokensIn, tokensOut, credits, trueCostMicros, status, day, failReason).run();
}

// 搜索与生图的按次费都不在 usage 里，按厂商登记单独补计（每次搜索 searchCallMicros、每张图 imageGenerationCallMicros）
export function computeTrueCostMicros(
  model: string | null | undefined,
  tokensIn: number,
  tokensOut: number,
  searchCalls = 0,
  cachedTokens = 0,
  imageGenerationCalls = 0,
): number {
  const price = priceOf(model as string) ?? DEFAULT_PRICE;
  const cached = Math.min(Math.max(cachedTokens, 0), tokensIn);
  const inputMicros = (tokensIn - cached) * price.inPerM + cached * (price.cachedInPerM ?? price.inPerM);
  const provider = providerOf(model as string);
  return Math.ceil((inputMicros + tokensOut * price.outPerM) / 1_000_000)
    + searchCalls * provider.searchCallMicros
    + imageGenerationCalls * provider.imageGenerationCallMicros;
}

// 当前 UTC 日（'YYYY-MM-DD'）
const utcToday = (): string => new Date().toISOString().slice(0, 10);

// 次日 UTC 零点：429 的 resetAt 与 /api/quota 的下次授予时间共用
export function nextGrantAtUTC(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

export interface BillingGateInput {
  installId: string;
  userSub?: string | null;
  tier: Tier;
  feature: string;
  day: string;
  extraCostMicros?: number;
  request?: Request | null;
  waitUntil?: ((p: Promise<unknown>) => void) | null;
}

// 统一计费闸（所有 feature 共用）：全局熔断 → 身份 → 懒授予 → 原子预扣 + pending 留痕。
// 放行返回 { identity, credits, eventId }；拦截返回 { error: 'quota_global'|'quota_device', resetAt }。
// 预扣与留痕在同一个 D1 batch，第二条用 `WHERE changes() > 0` 绑定第一条的结果——扣款失败则
// 整体无副作用；分两次写会留下「钱扣了却无任何记录」的窗口。
export async function runBillingGate(
  ctx: ChatContext,
  { installId, userSub, tier, feature, day, extraCostMicros = 0, request = null, waitUntil = null }: BillingGateInput,
): Promise<BillingGate> {
  // 拦截理由只有服务端知道，回调给宿主做埋点；quota_global 逐请求打点、
  // 有意不去重/采样——量级可忽略，原始事件保留完整时间分辨率。宿主抛错不能影响计费闸
  const blocked = (reason: "quota_global" | "quota_device") => {
    try {
      ctx.onBlocked?.({ reason, tier, feature, installId, userSub: userSub ?? null, request, waitUntil });
    } catch (e) {
      console.error("[billing] onBlocked threw", e);
    }
  };

  if (await checkGlobalBudget(ctx, tier, day, extraCostMicros)) {
    blocked("quota_global");
    return { error: "quota_global", resetAt: nextGrantAtUTC(day) };
  }
  let identity = await resolveIdentity(ctx, { installId, userSub });
  identity = await ensureDailyGrant(ctx, identity, tier, day);
  const credits = ctx.credits.rateCard[feature] ?? 1;

  const [charged, logged] = await ctx.db.batch([
    ctx.db.prepare("UPDATE identities SET balance = balance - ? WHERE id = ? AND balance >= ?")
      .bind(credits, identity.id, credits),
    ctx.db.prepare(
      "INSERT INTO usage_events (identity_id, tier, feature, credits, status, day) " +
      "SELECT ?, ?, ?, ?, 'pending', ? WHERE changes() > 0",
    ).bind(identity.id, tier, feature, credits, day),
  ]);
  const chargedChanges = charged.meta?.changes ?? 0;
  const loggedChanges = logged.meta?.changes ?? 0;

  // 不变量守卫（双向）：changes() 跨语句语义仅在本地 workerd 实测过，远程 D1 有差异时
  // 这两条日志当天暴露，而非等故障复盘
  if (chargedChanges === 0) {
    // 反向失衡：没扣款却留下 pending 行——回收时会照常退款，等于凭空造币
    if (loggedChanges > 0) {
      console.error("[billing] pending row created without a charge", { identityId: identity.id, feature });
    }
    blocked("quota_device");
    return { error: "quota_device", resetAt: nextGrantAtUTC(day) };
  }
  if (loggedChanges === 0) {
    console.error("[billing] pending row missing after successful charge", { identityId: identity.id, feature });
    // 不能把 last_row_id 当 eventId——未插入时它是此前任意一次 INSERT 的 rowid，
    // 拿去 UPDATE 会改到别人的行；回落 null 走 recordEvent 旧路径至少能留痕
    return { identity, credits, eventId: null };
  }
  return { identity, credits, eventId: logged.meta.last_row_id };
}

export interface SettleUsageInput {
  identity: Pick<Identity, "id">;
  tier: Tier;
  feature: string;
  model: string | null | undefined;
  credits: number;
  usage: Usage | null | undefined;
  ok: boolean;
  day: string;
  eventId?: number | null;
  failReason?: FailReason | null;
  costMicros?: number | null;
}

// 结算：把 pending 行推向终态（成功 → ok 回填成本；失败 → aborted + 退还预扣）。
// 两条 UPDATE 都带 `AND status='pending'` 的幂等锁：与回收 cron 竞争同一行只有一方生效；
// 先认领后退款的顺序不可颠倒——反过来并发下会退两次。
// eventId 为空时回落「插行」旧路径（pending 未落的应急回落），正常流量不走。
// failReason：ok=false 时写入，区分上游失败与客户端断流。
// costMicros：按非 token 口径计价的 feature（转写按时长）由调用方算好传入，缺省按 token 牌价
export async function settleUsage(
  ctx: ChatContext,
  { identity, tier, feature, model, credits, usage, ok, day, eventId = null, failReason = null, costMicros = null }: SettleUsageInput,
): Promise<void> {
  const tokensIn = usage?.prompt_tokens ?? 0;
  const tokensOut = usage?.completion_tokens ?? 0;
  const imageGenerationCalls = usage?.image_generation_calls ?? 0;
  const trueCost = costMicros ?? computeTrueCostMicros(model, tokensIn, tokensOut, usage?.search_calls ?? 0, usage?.cached_tokens ?? 0, imageGenerationCalls);
  // 失败没给原因统一记 unknown 而非 NULL——NULL 已被历史行占用为「无从得知」
  const reason = ok ? null : (failReason ?? "unknown");
  // 开了生图但模型判断不必出图：只按普通 chat 计，多预扣的部分退还
  const settledCredits = (ok && feature === "chat_image_generation" && imageGenerationCalls === 0) ? ctx.credits.rateCard.chat : credits;

  if (eventId == null) {
    // 与 pending 路径同口径：跨 UTC 日不退款（口径必须一致，防日后复用踩坑）
    if (day === utcToday()) {
      if (!ok) await refundCredits(ctx, identity.id, credits);
      else if (settledCredits < credits) await refundCredits(ctx, identity.id, credits - settledCredits);
    }
    await recordEvent(ctx, {
      identityId: identity.id,
      tier,
      feature,
      model: model ?? null,
      tokensIn,
      tokensOut,
      credits: ok ? settledCredits : 0,
      trueCostMicros: ok ? trueCost : 0,
      status: ok ? "ok" : "aborted",
      day,
      failReason: reason,
    });
    return;
  }

  if (ok) {
    const stmts = [
      ctx.db.prepare(
        "UPDATE usage_events SET status = 'ok', model = ?, tokens_in = ?, tokens_out = ?, true_cost_micros = ?, credits = ? " +
        "WHERE id = ? AND status = 'pending'",
      ).bind(model ?? null, tokensIn, tokensOut, trueCost, settledCredits, eventId),
    ];
    // 部分退还与失败退款同口径：仅当日、且绑在认领成功之后
    if (settledCredits < credits && day === utcToday()) {
      stmts.push(ctx.db.prepare(
        "UPDATE identities SET balance = balance + ? WHERE id = ? AND changes() > 0",
      ).bind(credits - settledCredits, identity.id));
    }
    const [settled] = await ctx.db.batch(stmts);
    // 认领落败 = 回收 cron 已判死（阈值太窄）：请求实际成功但成本再也写不进账本，必须告警
    if ((settled.meta?.changes ?? 0) === 0) {
      console.error("[billing] settle(ok) lost race with reclaim; cost unrecorded",
        { eventId, feature, tokensIn, tokensOut });
    }
    return;
  }

  // 失败：认领 + 退款必须同 batch——分两次写、进程死在中间会永久吞钱（状态已非 pending，
  // 回收 cron 扫不到）。tokens 照写：失败也可能已烧 token，成本归因不能丢。
  const stmts = [
    ctx.db.prepare(
      "UPDATE usage_events SET status = 'aborted', model = ?, tokens_in = ?, tokens_out = ?, credits = 0, fail_reason = ? " +
      "WHERE id = ? AND status = 'pending'",
    ).bind(model ?? null, tokensIn, tokensOut, reason, eventId),
  ];
  // 退款仅限当日：跨 UTC 零点后旧额度按不结转语义已作废，退进新一天等于凭空加额度
  // （与 reclaimOrphanedPending 同口径）
  if (day === utcToday()) {
    stmts.push(ctx.db.prepare(
      "UPDATE identities SET balance = balance + ? WHERE id = ? AND changes() > 0",
    ).bind(credits, identity.id));
  }
  await ctx.db.batch(stmts);
}

// pending 超时阈值（毫秒）：必须大于该 feature 正常最长耗时，宁宽勿窄——设窄会把活着的请求
// 误判成孤儿，退款后真结算被幂等锁挡掉，用户白嫖一次且账本多一条假 aborted。
export const PENDING_TIMEOUT_MS: Record<string, number> = {
  chat: 5 * 60 * 1000,
  chat_search: 10 * 60 * 1000, // hosted web_search 会显著拉长单次耗时
  chat_image_generation: 10 * 60 * 1000, // 生图官方上限约 2 min，再加正文
  chat_voice: 5 * 60 * 1000,
};
const DEFAULT_PENDING_TIMEOUT_MS = 10 * 60 * 1000;

interface PendingRow {
  id: number;
  identity_id: number;
  feature: string;
  credits: number;
  day: string;
  created_at: string;
}

export interface ReclaimResult {
  scanned: number;
  reclaimed: number;
  refunded: number;
}

// 回收孤儿 pending——pending 状态机的唯一兜底出口：进程死在预扣与结算之间时那行永远停在 pending。
// 顺序纪律与 settleUsage 一致：先条件更新认领，changes>0 才退款；退款仅限当日。
export async function reclaimOrphanedPending(ctx: ChatContext, { limit = 200 }: { limit?: number } = {}): Promise<ReclaimResult> {
  // 只捞**真正超时**的行——长寿 feature 的 pending 会把 5 分钟就该回收的 chat 孤儿挤出 LIMIT 窗口。
  // 阈值从 PENDING_TIMEOUT_MS 生成避免漂移；feature 名是内部常量，无注入面。
  const known = Object.keys(PENDING_TIMEOUT_MS);
  const overdue = [
    ...known.map((f) =>
      `(feature = '${f}' AND created_at < datetime('now', '-${Math.round(PENDING_TIMEOUT_MS[f] / 60000)} minutes'))`),
    `(feature NOT IN (${known.map((f) => `'${f}'`).join(", ")}) ` +
      `AND created_at < datetime('now', '-${Math.round(DEFAULT_PENDING_TIMEOUT_MS / 60000)} minutes'))`,
  ].join(" OR ");

  const { results } = await ctx.db.prepare(
    "SELECT id, identity_id, feature, credits, day, created_at FROM usage_events " +
    `WHERE status = 'pending' AND (${overdue}) ORDER BY created_at LIMIT ?`,
  ).bind(limit).all<PendingRow>();

  const now = Date.now();
  const today = utcToday();
  let reclaimed = 0;
  let refunded = 0;

  for (const row of results ?? []) {
    const timeout = PENDING_TIMEOUT_MS[row.feature] ?? DEFAULT_PENDING_TIMEOUT_MS;
    // created_at 是 D1 datetime('now') 的 UTC 串，无时区后缀
    const createdMs = Date.parse(`${String(row.created_at).replace(" ", "T")}Z`);
    if (!Number.isFinite(createdMs) || now - createdMs < timeout) continue;

    // 认领 + 退款同批：分两次写、死在中间即本函数要根治的那种永久吞钱
    const sameDay = row.day === today;
    const stmts = [
      ctx.db.prepare(
        "UPDATE usage_events SET status = 'aborted', credits = 0, fail_reason = 'reclaimed' " +
        "WHERE id = ? AND status = 'pending'",
      ).bind(row.id),
    ];
    if (sameDay) {
      stmts.push(ctx.db.prepare(
        "UPDATE identities SET balance = balance + ? WHERE id = ? AND changes() > 0",
      ).bind(row.credits, row.identity_id));
    }
    const [claimed] = await ctx.db.batch(stmts);
    if ((claimed.meta?.changes ?? 0) === 0) continue; // 被 settle 抢先认领，属正常竞争
    reclaimed++;
    if (sameDay) refunded++;
  }
  if (reclaimed) console.log("[billing] reclaimed orphaned pending", { reclaimed, refunded });
  return { scanned: results?.length ?? 0, reclaimed, refunded };
}

// 全局熔断：池内（匿名 vs 登录）当日真实成本达预算即熔断；只统计 status='ok'——aborted 不计费也不该吃预算
export async function checkGlobalBudget(ctx: ChatContext, tier: Tier, day: string, extraMicros = 0): Promise<boolean> {
  const poolFilter = tier === "anonymous" ? "tier = 'anonymous'" : "tier <> 'anonymous'";
  const budget = tier === "anonymous" ? ctx.credits.globalBudgetMicros.anonymous : ctx.credits.globalBudgetMicros.user;
  const row = await ctx.db.prepare(
    `SELECT COALESCE(SUM(true_cost_micros), 0) AS total FROM usage_events WHERE day = ? AND status = 'ok' AND ${poolFilter}`,
  ).bind(day).first<{ total: number }>();
  // extraMicros：已知会发生但尚未结算的在途成本（如生图按次费），让熔断提前看见
  return ((row?.total ?? 0) + extraMicros) >= budget;
}
