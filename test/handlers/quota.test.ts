import { describe, it, expect, vi, afterEach } from "vitest";
import { handleQuota } from "../../src/handlers/quota.js";
import { DEFAULT_CREDITS } from "../../src/config.js";
import { makeCtx, tierInfo, hasSql, json } from "./helpers.js";

// GET /api/quota：余额可见性接口——撞墙体验的一部分（「还剩多少、何时重置」）

const makeGet = ({ installId = "dev-1" as string | null } = {}) =>
  new Request("https://api.trendingai.cn/api/quota", {
    method: "GET",
    headers: installId ? { "X-Install-Id": installId } : {},
  });

afterEach(() => vi.restoreAllMocks());

describe("GET /api/quota", () => {
  it("匿名 → 返回余额、日授予额、resetAt 与档位", async () => {
    const res = await handleQuota(makeGet(), makeCtx({ db: { balance: 3 } }));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.balance).toBe(3);
    expect(body.dailyGrant).toBe(DEFAULT_CREDITS.dailyGrant.anonymous);
    expect(body.tier).toBe("anonymous");
    // resetAt = 次日 UTC 零点
    expect(body.resetAt).toMatch(/T00:00:00\.000Z$/);
    expect(new Date(body.resetAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("余额不应被缓存（no-store）", async () => {
    const res = await handleQuota(makeGet(), makeCtx());
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });

  it("缺 install id → 400 missing_install_id", async () => {
    const res = await handleQuota(makeGet({ installId: null }), makeCtx());
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe("missing_install_id");
  });

  it("非 GET → 405", async () => {
    const req = new Request("https://api.trendingai.cn/api/quota", {
      method: "POST",
      headers: { "X-Install-Id": "dev-1" },
    });
    const res = await handleQuota(req, makeCtx());
    expect(res.status).toBe(405);
  });

  it("宿主判定 authInvalid → 401 auth_invalid", async () => {
    const res = await handleQuota(makeGet(), makeCtx({ tier: { authInvalid: true } }));
    expect(res.status).toBe(401);
    expect((await json(res)).code).toBe("auth_invalid");
  });

  it("resolveTier 抛错 → 500 internal", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = makeCtx();
    ctx.resolveTier.mockRejectedValue(new Error("boom"));
    const res = await handleQuota(makeGet(), ctx);
    expect(res.status).toBe(500);
    expect((await json(res)).code).toBe("internal");
  });

  it("Pro 用户 → dailyGrant 按 pro 档、tier=pro，且查询即完成当日懒授予", async () => {
    // 用户主体行 last_grant_tier=user → 档位变化触发按 pro 档重授（SET 100）
    const ctx = makeCtx({ db: { userIdentity: { balance: 2, last_grant_tier: "user" } }, tier: tierInfo("pro", "p-1") });
    const res = await handleQuota(makeGet(), ctx);
    const body = await json(res);
    expect(body.tier).toBe("pro");
    expect(body.dailyGrant).toBe(DEFAULT_CREDITS.dailyGrant.pro);
    expect(body.balance).toBe(DEFAULT_CREDITS.dailyGrant.pro);
    expect(hasSql(ctx.db, "INSERT INTO credit_grants")).toBe(true);
  });
});
