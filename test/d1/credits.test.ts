import { env } from "cloudflare:test";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  runBillingGate, settleUsage, reclaimOrphanedPending, ensureDailyGrant, resolveIdentity, checkGlobalBudget,
} from "../../src/credits.js";
import { DEFAULT_CREDITS, type ChatContext } from "../../src/config.js";

const { dailyGrant: DAILY_GRANT, rateCard: RATE_CARD, globalBudgetMicros: GLOBAL_BUDGET_MICROS } = DEFAULT_CREDITS;

// 只给账本用到的字段：不带 onBlocked 时拦截不外发
const C = { db: env.DB, credits: DEFAULT_CREDITS, onBlocked: null } as ChatContext;
const day = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

const identityRow = (id: number) => env.DB.prepare("SELECT * FROM identities WHERE id = ?").bind(id).first<any>();
const eventRow = (id: number) => env.DB.prepare("SELECT * FROM usage_events WHERE id = ?").bind(id).first<any>();
const pendingCount = () => env.DB.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE status = 'pending'").first<{ n: number }>().then((r) => r!.n);
const backdate = (eventId: number, minutes: number) => env.DB.prepare(
  "UPDATE usage_events SET created_at = datetime('now', ?) WHERE id = ?",
).bind(`-${minutes} minutes`, eventId).run();

const gate = (over: Record<string, unknown> = {}) => runBillingGate(C, { installId: "dev-1", userSub: null, tier: "anonymous", feature: "chat", day, ...over });

// 同文件内各用例共用同一份 D1（实测写入会累积，pool-workers 未按用例回滚），每条用例前清空账本三表
beforeEach(() => env.DB.batch([
  env.DB.prepare("DELETE FROM usage_events"),
  env.DB.prepare("DELETE FROM credit_grants"),
  env.DB.prepare("DELETE FROM identities"),
]));
afterEach(() => vi.restoreAllMocks());

describe("runBillingGate：预扣与 pending 留痕同批", () => {
  it("首次请求：建身份、当日授予、扣 1、留 pending 行，eventId 指向该行", async () => {
    const g = await gate();
    expect(g.error).toBeUndefined();
    expect((await identityRow(g.identity!.id)).balance).toBe(DAILY_GRANT.anonymous - 1);
    const ev = await eventRow(g.eventId!);
    expect(ev).toMatchObject({ identity_id: g.identity!.id, feature: "chat", credits: 1, status: "pending", day });
  });

  it("额度耗尽：第 N+1 次扣款改 0 行，pending 行不产生（changes() 挡下第二条语句）", async () => {
    for (let i = 0; i < DAILY_GRANT.anonymous; i++) expect((await gate()).error).toBeUndefined();
    const g = await gate();
    expect(g.error).toBe("quota_device");
    expect(await pendingCount()).toBe(DAILY_GRANT.anonymous);
  });

  it("rate card 按 feature 扣：chat_image_generation 扣 10", async () => {
    const g = await runBillingGate(C, { installId: "dev-1", userSub: "u-1", tier: "user", feature: "chat_image_generation", day });
    expect((await identityRow(g.identity!.id)).balance).toBe(DAILY_GRANT.user - RATE_CARD.chat_image_generation);
    expect((await eventRow(g.eventId!)).credits).toBe(RATE_CARD.chat_image_generation);
  });

  it("拦截时回调 onBlocked，宿主抛错不影响拦截结果", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const onBlocked = vi.fn(() => { throw new Error("host boom"); });
    const ctx = { ...C, onBlocked } as ChatContext;
    for (let i = 0; i < DAILY_GRANT.anonymous; i++) await runBillingGate(ctx, { installId: "dev-1", userSub: null, tier: "anonymous", feature: "chat", day });
    const g = await runBillingGate(ctx, { installId: "dev-1", userSub: null, tier: "anonymous", feature: "chat", day });
    expect(g.error).toBe("quota_device");
    expect(onBlocked).toHaveBeenCalledWith(expect.objectContaining({ reason: "quota_device", tier: "anonymous", feature: "chat", installId: "dev-1", userSub: null }));
    expect(err).toHaveBeenCalledWith(expect.stringContaining("onBlocked"), expect.anything());
  });
});

describe("settleUsage 与 reclaimOrphanedPending 的幂等锁", () => {
  it("ok 结算：pending → ok 回填成本；之后 reclaim 扫不到它", async () => {
    const g = await gate();
    await settleUsage(C, { identity: g.identity!, tier: "anonymous", feature: "chat", model: "gpt-5.6-luna", credits: 1, usage: { prompt_tokens: 100, completion_tokens: 50 }, ok: true, day, eventId: g.eventId });
    const ev = await eventRow(g.eventId!);
    expect(ev.status).toBe("ok");
    expect(ev.true_cost_micros).toBeGreaterThan(0);
    await backdate(g.eventId!, 30);
    expect(await reclaimOrphanedPending(C)).toEqual({ scanned: 0, reclaimed: 0, refunded: 0 });
    expect((await identityRow(g.identity!.id)).balance).toBe(DAILY_GRANT.anonymous - 1);
  });

  it("失败结算：认领 + 当日退款同批；重复结算不再退第二次", async () => {
    const g = await gate();
    const fail = () => settleUsage(C, { identity: g.identity!, tier: "anonymous", feature: "chat", model: "gpt-5.6-luna", credits: 1, usage: null, ok: false, day, eventId: g.eventId, failReason: "upstream_error" });
    await fail();
    expect((await identityRow(g.identity!.id)).balance).toBe(DAILY_GRANT.anonymous);
    expect(await eventRow(g.eventId!)).toMatchObject({ status: "aborted", credits: 0, fail_reason: "upstream_error" });
    await fail();
    expect((await identityRow(g.identity!.id)).balance).toBe(DAILY_GRANT.anonymous);
  });

  it("reclaim 抢先判死退款后，迟到的 ok 结算改 0 行：不重复动余额、行保持 aborted、留告警", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const g = await gate();
    await backdate(g.eventId!, 10); // chat 阈值 5 分钟
    expect(await reclaimOrphanedPending(C)).toMatchObject({ reclaimed: 1, refunded: 1 });
    expect((await identityRow(g.identity!.id)).balance).toBe(DAILY_GRANT.anonymous);

    await settleUsage(C, { identity: g.identity!, tier: "anonymous", feature: "chat", model: "gpt-5.6-luna", credits: 1, usage: { prompt_tokens: 10, completion_tokens: 10 }, ok: true, day, eventId: g.eventId });
    expect(await eventRow(g.eventId!)).toMatchObject({ status: "aborted", credits: 0, fail_reason: "reclaimed" });
    expect((await identityRow(g.identity!.id)).balance).toBe(DAILY_GRANT.anonymous);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("lost race with reclaim"), expect.anything());
  });

  it("reclaim 只捞真正超时的：chat_search 阈值 10 分钟，7 分钟的 pending 不动", async () => {
    const g = await runBillingGate(C, { installId: "dev-1", userSub: "u-1", tier: "user", feature: "chat_search", day });
    await backdate(g.eventId!, 7);
    expect(await reclaimOrphanedPending(C)).toEqual({ scanned: 0, reclaimed: 0, refunded: 0 });
    await backdate(g.eventId!, 15);
    expect(await reclaimOrphanedPending(C)).toMatchObject({ reclaimed: 1 });
  });

  it("跨 UTC 日的失败结算：认领 aborted 但不退款（昨日额度已作废）", async () => {
    const g = await gate({ day: yesterday });
    await settleUsage(C, { identity: g.identity!, tier: "anonymous", feature: "chat", model: null, credits: 1, usage: null, ok: false, day: yesterday, eventId: g.eventId, failReason: "client_abort" });
    expect((await eventRow(g.eventId!)).status).toBe("aborted");
    expect((await identityRow(g.identity!.id)).balance).toBe(DAILY_GRANT.anonymous - 1);
  });

  it("生图预扣 10、模型没出图：按 chat 计 1，多扣的 9 退回", async () => {
    const g = await runBillingGate(C, { installId: "dev-1", userSub: "u-pro", tier: "pro", feature: "chat_image_generation", day });
    expect((await identityRow(g.identity!.id)).balance).toBe(DAILY_GRANT.pro - RATE_CARD.chat_image_generation);
    await settleUsage(C, { identity: g.identity!, tier: "pro", feature: "chat_image_generation", model: "gpt-5.6-luna", credits: RATE_CARD.chat_image_generation, usage: { prompt_tokens: 10, completion_tokens: 10, image_generation_calls: 0 }, ok: true, day, eventId: g.eventId });
    expect((await eventRow(g.eventId!)).credits).toBe(RATE_CARD.chat);
    expect((await identityRow(g.identity!.id)).balance).toBe(DAILY_GRANT.pro - RATE_CARD.chat);
  });
});

describe("ensureDailyGrant：不结转、同日按档重授一次", () => {
  it("同日升 Pro 立即按 100 重授并落第二条 grant；同档再调不重复授", async () => {
    let idn = await resolveIdentity(C, { installId: "dev-1", userSub: "u-1" });
    idn = await ensureDailyGrant(C, idn, "user", day);
    expect(idn.balance).toBe(DAILY_GRANT.user);
    idn = await ensureDailyGrant(C, idn, "pro", day);
    expect(idn.balance).toBe(DAILY_GRANT.pro);
    idn = await ensureDailyGrant(C, idn, "pro", day);
    const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM credit_grants WHERE identity_id = ?").bind(idn.id).first<{ n: number }>())!;
    expect(n).toBe(2);
  });

  it("库内已被别的请求授过（last_grant_day 已是今日）→ 条件更新改 0 行，以库内余额为准", async () => {
    const idn = await resolveIdentity(C, { installId: "dev-1", userSub: null });
    await ensureDailyGrant(C, idn, "anonymous", day);
    await env.DB.prepare("UPDATE identities SET balance = 2 WHERE id = ?").bind(idn.id).run();
    // 拿着「过期快照」（last_grant_day 仍为 null）再来：不能覆盖成 5
    const again = await ensureDailyGrant(C, idn, "anonymous", day);
    expect(again.balance).toBe(2);
  });
});

describe("resolveIdentity：设备主体升级为用户主体", () => {
  it("登录后设备行被接管（user_sub 写入、授予日清空）；同一设备再匿名访问得到新的设备行", async () => {
    const device = await resolveIdentity(C, { installId: "dev-1", userSub: null });
    await ensureDailyGrant(C, device, "anonymous", day);
    const user = await resolveIdentity(C, { installId: "dev-1", userSub: "u-1" });
    expect(user.id).toBe(device.id);
    expect(user.last_grant_day).toBeNull();
    expect((await identityRow(device.id)).user_sub).toBe("u-1");

    const device2 = await resolveIdentity(C, { installId: "dev-1", userSub: null });
    expect(device2.id).not.toBe(device.id);
    // 同一用户换设备 → 仍是用户主体行
    const user2 = await resolveIdentity(C, { installId: "dev-9", userSub: "u-1" });
    expect(user2.id).toBe(device.id);
  });
});

describe("checkGlobalBudget：只算 ok、按池分账", () => {
  it("匿名池达标熔断，登录池不受影响", async () => {
    const g = await gate();
    await settleUsage(C, { identity: g.identity!, tier: "anonymous", feature: "chat", model: "gpt-5.6-luna", credits: 1, usage: { prompt_tokens: 1, completion_tokens: 1 }, ok: true, day, eventId: g.eventId });
    await env.DB.prepare("UPDATE usage_events SET true_cost_micros = ? WHERE id = ?").bind(GLOBAL_BUDGET_MICROS.anonymous, g.eventId).run();
    expect(await checkGlobalBudget(C, "anonymous", day)).toBe(true);
    expect(await checkGlobalBudget(C, "user", day)).toBe(false);
    // aborted 行不计预算
    await env.DB.prepare("UPDATE usage_events SET status = 'aborted' WHERE id = ?").bind(g.eventId).run();
    expect(await checkGlobalBudget(C, "anonymous", day)).toBe(false);
  });
});
