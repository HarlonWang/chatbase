import { describe, it, expect, vi, afterEach } from "vitest";
import {
  resolveIdentity,
  ensureDailyGrant,
  chargeCredits,
  refundCredits,
  recordEvent,
  computeTrueCostMicros,
  checkGlobalBudget,
  reclaimOrphanedPending,
  runBillingGate,
  settleUsage,
  nextGrantAtUTC,
  PENDING_TIMEOUT_MS,
  type Identity,
} from "../src/credits.js";
import { hasModelPrice } from "../src/providers.js";
import { DEFAULT_CREDITS, type ChatContext } from "../src/config.js";

// ---------------------------------------------------------------------------
// 工具：SQL 子串 keyed 的 D1 mock，
// firstBySql: [ [子串, 返回值], ... ] 按序匹配；runMeta 控制 meta.changes。
// ---------------------------------------------------------------------------

type SqlTable = Array<[string, any]>;
interface DBOpts { firstBySql?: SqlTable; allBySql?: SqlTable; runMeta?: { changes: number; last_row_id?: number } }

const makeDB = ({ firstBySql = [], allBySql = [], runMeta = { changes: 1 } }: DBOpts = {}) => {
  const calls = { sql: [] as string[], binds: [] as any[][] };
  // 真正执行过的语句（区别于仅 prepare 的）：batch 内被 `changes() > 0` 挡下的语句不入列。
  // 退款是否发生现在由数据库条件决定，而非 JS 分支，断言必须看这里。
  const executed: string[] = [];
  let eventSeq = 0;

  const lookup = (table: SqlTable, sql: string, fallback: any) => {
    for (const [substr, value] of table) if (sql.includes(substr)) return value;
    return fallback;
  };

  // prepare 必须返回**独立的** statement 对象（而非链式返回 db 自身）：
  // batch() 拿到的是语句数组，逐条执行时需要各自的 sql/binds。
  // 但执行仍**委托回 db 上的方法**——部分并发测试通过覆写 db.first 注入场景，
  // 若把实现塞进 stmt 内部，那些覆写会静默失效。
  const makeStmt = (sql: string) => {
    calls.sql.push(sql);
    let binds: any[] = [];
    const stmt: any = {
      sql,
      bind: vi.fn((...args: any[]) => { binds = args; calls.binds.push(args); return stmt; }),
      run: vi.fn(async () => { executed.push(sql); return db.run(sql); }),
      first: vi.fn(async () => db.first(sql)),
      all: vi.fn(async () => db.all(sql)),
    };
    return stmt;
  };

  const db: any = {
    calls,
    executed,
    // 默认实现按 SQL 子串匹配；显式传入 sql 是为了 batch——批内多条语句已全部 prepare 过，
    // 此时 calls.sql.at(-1) 指向最后一条，不能代表正在执行的那条。
    run: vi.fn(async (sql: string = calls.sql.at(-1) ?? "") => (sql.includes("INSERT INTO usage_events")
      ? { meta: { changes: 1, last_row_id: ++eventSeq } }
      : { meta: runMeta })),
    first: vi.fn(async (sql: string = calls.sql.at(-1) ?? "") => lookup(firstBySql, sql, null)),
    all: vi.fn(async (sql: string = calls.sql.at(-1) ?? "") => ({ results: lookup(allBySql, sql, []) })),
    prepare: vi.fn(makeStmt),
    // 复现 D1 batch 的关键语义：语句顺序执行，且 `WHERE changes() > 0` 读到的是**上一条**语句
    // 影响的行数。runBillingGate 的原子性正建立在这条语义上（已在本地 workerd 实测确认）。
    batch: vi.fn(async (stmts: any[]) => {
      const out: any[] = [];
      let lastChanges = 0;
      for (const stmt of stmts) {
        if (stmt.sql.includes("changes() > 0") && lastChanges === 0) {
          out.push({ meta: { changes: 0, last_row_id: 0 } }); // 条件不成立 → 未插入
          continue;
        }
        const r = await stmt.run();
        lastChanges = r.meta?.changes ?? 0;
        out.push(r);
      }
      return out;
    }),
  };
  return db;
};

type Ctx = ChatContext & { db: ReturnType<typeof makeDB>; onBlocked: ReturnType<typeof vi.fn> };
const makeCtx = (dbOpts?: DBOpts): Ctx => ({ db: makeDB(dbOpts), credits: DEFAULT_CREDITS, onBlocked: vi.fn() } as unknown as Ctx);

const { dailyGrant: DAILY_GRANT, rateCard: RATE_CARD, globalBudgetMicros: GLOBAL_BUDGET_MICROS } = DEFAULT_CREDITS;

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// resolveIdentity：身份解析与登录升级
// ---------------------------------------------------------------------------

describe("resolveIdentity", () => {
  it("匿名新设备 → 创建设备主体身份", async () => {
    const ctx = makeCtx({
      firstBySql: [
        // 第一次 SELECT 未命中 → INSERT 后 RETURNING 拿到新行
        ["INSERT INTO identities", { id: 7, install_id: "dev-1", user_sub: null, balance: 0, last_grant_day: null }],
      ],
    });
    const identity = await resolveIdentity(ctx, { installId: "dev-1", userSub: null });
    expect(identity.id).toBe(7);
    // 匿名查找必须限定设备主体（user_sub IS NULL），避免命中已升级为用户主体的行
    const selectSql = ctx.db.calls.sql.find((s: string) => s.includes("SELECT") && s.includes("install_id"));
    expect(selectSql).toContain("user_sub IS NULL");
  });

  it("登录且已有用户主体 → 直接复用", async () => {
    const row = { id: 3, install_id: "dev-0", user_sub: "user_u1", balance: 4, last_grant_day: "2026-07-19" };
    const ctx = makeCtx({ firstBySql: [["user_sub = ?", row]] });
    const identity = await resolveIdentity(ctx, { installId: "dev-1", userSub: "user_u1" });
    expect(identity).toEqual(row);
    // 不应有 INSERT
    expect(ctx.db.calls.sql.some((s: string) => s.includes("INSERT"))).toBe(false);
  });

  it("登录且仅有设备主体 → 升级：写入 user_sub 并清空 last_grant_day（触发按新档重授）", async () => {
    const deviceRow = { id: 5, install_id: "dev-1", user_sub: null, balance: 2, last_grant_day: "2026-07-19" };
    const ctx = makeCtx({
      firstBySql: [
        ["user_sub = ?", null], // 用户主体不存在
        ["user_sub IS NULL", deviceRow], // 命中设备主体
      ],
    });
    const identity = await resolveIdentity(ctx, { installId: "dev-1", userSub: "user_u9" });
    expect(identity.user_sub).toBe("user_u9");
    expect(identity.last_grant_day).toBe(null);
    const promoteSql = ctx.db.calls.sql.find((s: string) => s.includes("UPDATE identities") && s.includes("user_sub"));
    expect(promoteSql).toBeTruthy();
    expect(promoteSql).toContain("last_grant_day = NULL");
  });
});

// ---------------------------------------------------------------------------
// ensureDailyGrant：懒授予（不结转 = SET 而非 +=）
// ---------------------------------------------------------------------------

describe("ensureDailyGrant", () => {
  it("当日首次 → balance 置为档位授予额并落一条 grant", async () => {
    const identity = { id: 5, balance: 2, last_grant_day: "2026-07-18" } as Identity;
    const ctx = makeCtx();
    const updated = await ensureDailyGrant(ctx, identity, "user", "2026-07-19");
    expect(updated.balance).toBe(DAILY_GRANT.user);
    // 授予是 SET 语义（免费额度当日过期不结转），不是 +=
    const grantSql = ctx.db.calls.sql.find((s: string) => s.includes("UPDATE identities") && s.includes("balance = ?"));
    expect(grantSql).toBeTruthy();
    // 条件更新做并发去重：同日只授一次
    expect(grantSql).toContain("last_grant_day");
    expect(ctx.db.calls.sql.some((s: string) => s.includes("INSERT INTO credit_grants"))).toBe(true);
  });

  it("同日已授予 → 原样返回，不再写库", async () => {
    const identity = { id: 5, balance: 3, last_grant_day: "2026-07-19", last_grant_tier: "user" } as Identity;
    const ctx = makeCtx();
    const updated = await ensureDailyGrant(ctx, identity, "user", "2026-07-19");
    expect(updated.balance).toBe(3);
    expect(ctx.db.calls.sql.length).toBe(0);
  });

  it("并发竞争落败（changes=0）→ 不落 grant，重读余额为准", async () => {
    const identity = { id: 5, balance: 0, last_grant_day: "2026-07-18" } as Identity;
    const ctx = makeCtx({
      runMeta: { changes: 0 },
      firstBySql: [["SELECT", { id: 5, balance: 9, last_grant_day: "2026-07-19" }]],
    });
    const updated = await ensureDailyGrant(ctx, identity, "user", "2026-07-19");
    expect(updated.balance).toBe(9);
    expect(ctx.db.calls.sql.some((s: string) => s.includes("INSERT INTO credit_grants"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// chargeCredits / refundCredits：原子扣减
// ---------------------------------------------------------------------------

describe("chargeCredits", () => {
  it("余额充足 → true，SQL 为条件原子扣减", async () => {
    const ctx = makeCtx({ runMeta: { changes: 1 } });
    const ok = await chargeCredits(ctx, 5, 3);
    expect(ok).toBe(true);
    const sql = ctx.db.calls.sql[0];
    expect(sql).toContain("balance = balance - ?");
    expect(sql).toContain("balance >= ?");
    expect(ctx.db.calls.binds[0]).toEqual([3, 5, 3]);
  });

  it("余额不足（changes=0）→ false", async () => {
    const ctx = makeCtx({ runMeta: { changes: 0 } });
    expect(await chargeCredits(ctx, 5, 3)).toBe(false);
  });
});

describe("refundCredits", () => {
  it("退还为加法更新", async () => {
    const ctx = makeCtx();
    await refundCredits(ctx, 5, 1);
    expect(ctx.db.calls.sql[0]).toContain("balance = balance + ?");
    expect(ctx.db.calls.binds[0]).toEqual([1, 5]);
  });
});

// ---------------------------------------------------------------------------
// recordEvent / computeTrueCostMicros / checkGlobalBudget
// ---------------------------------------------------------------------------

describe("recordEvent", () => {
  it("事件行含双币种与档位", async () => {
    const ctx = makeCtx();
    await recordEvent(ctx, {
      identityId: 5, tier: "user", feature: "chat", model: "gpt-5.4",
      tokensIn: 1000, tokensOut: 500, credits: 1, trueCostMicros: 650, status: "ok", day: "2026-07-19",
    });
    expect(ctx.db.calls.sql[0]).toContain("INSERT INTO usage_events");
    // 末位 fail_reason：ok 行为 null
    expect(ctx.db.calls.binds[0]).toEqual([5, "user", "chat", "gpt-5.4", 1000, 500, 1, 650, "ok", "2026-07-19", null]);
  });

  it("失败行写入 fail_reason（status 单值分不出上游失败与客户端断流）", async () => {
    const ctx = makeCtx();
    await recordEvent(ctx, {
      identityId: 5, tier: "user", feature: "chat", model: "gpt-5.4",
      tokensIn: 0, tokensOut: 0, credits: 0, trueCostMicros: 0, status: "aborted", day: "2026-08-04",
      failReason: "upstream_region_blocked",
    });
    expect(ctx.db.calls.binds[0].at(-1)).toBe("upstream_region_blocked");
  });
});

describe("computeTrueCostMicros", () => {
  // 官方牌价（developers.openai.com/api/docs/pricing，短上下文标准档，$/1M tokens）：
  // gpt-5.4 = 2.50/15；gpt-5.6-sol = 5/30；terra = 2.50/15；luna = 1/6
  it("默认模型 gpt-5.4 按官方牌价（此前 default 档低估约 2 倍，熔断偏晚）", () => {
    // 1000 in × $2.50/M = 2500μ$；500 out × $15/M = 7500μ$
    expect(computeTrueCostMicros("gpt-5.4", 1000, 500)).toBe(10000);
  });

  it("GPT-5.6 三档各按各价", () => {
    expect(computeTrueCostMicros("gpt-5.6-sol", 1000, 500)).toBe(14000);
    expect(computeTrueCostMicros("gpt-5.6-terra", 1000, 500)).toBe(8000);
    expect(computeTrueCostMicros("gpt-5.6-luna", 1000, 500)).toBe(800);
  });

  it("gpt-5.5 仍是最贵档（sol 促销价已低于它）", () => {
    expect(computeTrueCostMicros("gpt-5.5", 1000, 500)).toBe(20000);
    expect(computeTrueCostMicros("gpt-5.5", 1000, 500))
      .toBeGreaterThan(computeTrueCostMicros("gpt-5.6-sol", 1000, 500));
  });

  it("gpt-6-astra 按官方牌价（$10 / $50）", () => {
    expect(computeTrueCostMicros("gpt-6-astra", 1000, 500)).toBe(35000);
  });

  it("未知模型 → default 远高于在售旗舰（新模型自动上架，未补牌价时宁可早熔断）", () => {
    // 1000 × $30/M + 500 × $150/M = 30000 + 75000
    expect(computeTrueCostMicros("gpt-9-unknown", 1000, 500)).toBe(105000);
    expect(computeTrueCostMicros("gpt-9-unknown", 1000, 500))
      .toBeGreaterThan(computeTrueCostMicros("gpt-6-astra", 1000, 500));
  });

  it("缓存命中 token 按 cachedInPerM 折算；未登记缓存价的模型按全价", () => {
    // deepseek flash：$0.30 全价 / $0.006 缓存价 / $1.20 out；1000 in 里 800 命中，500 out
    // = (200×300000 + 800×6000 + 500×1200000) / 1e6 = 60 + 4.8 + 600 → 665（微美元，向上取整）
    expect(computeTrueCostMicros("deepseek-flash", 1000, 500, 0, 800)).toBe(665);
    expect(computeTrueCostMicros("deepseek-flash", 1000, 500)).toBe(900);
    // 旧名经别名同价，不会落到 default 高估
    expect(computeTrueCostMicros("deepseek-v4-flash", 1000, 500)).toBe(900);
    // OpenAI 未登记缓存价：cached 不改变成本
    expect(computeTrueCostMicros("gpt-5.6-luna", 1000, 500, 0, 800)).toBe(800);
    // cached 超过 tokensIn 时钳到 tokensIn，不出现负数
    expect(computeTrueCostMicros("deepseek-flash", 100, 0, 0, 999)).toBe(1);
  });

  it("搜索按次费按厂商：OpenAI 每次 $0.01，DeepSeek 为 0", () => {
    expect(computeTrueCostMicros("gpt-5.6-luna", 0, 0, 3)).toBe(30000);
    expect(computeTrueCostMicros("deepseek-flash", 0, 0, 3)).toBe(0);
    // 智谱：搜索按次 ¥0.01 ≈ 1500 微美元；1000 in / 500 out 全价 = 1143 + 2000
    expect(computeTrueCostMicros("glm-5.3", 1000, 500, 2)).toBe(1143 + 2000 + 3000);
  });

  it("hasModelPrice：已登记为 true，未知与 default 键本身为 false", () => {
    expect(hasModelPrice("gpt-6-astra")).toBe(true);
    expect(hasModelPrice("gpt-5.6-luna")).toBe(true);
    expect(hasModelPrice("gpt-9-unknown")).toBe(false);
    expect(hasModelPrice("default")).toBe(false);
  });

  it("零用量 → 0", () => {
    expect(computeTrueCostMicros("gpt-5.4", 0, 0)).toBe(0);
  });

  it("web_search 按次费（官方 $10/1k calls）→ 每次 10000μ$ 叠加在 token 成本上", () => {
    // token 部分 10000μ$ + 3 次搜索 × 10000μ$ = 40000μ$
    expect(computeTrueCostMicros("gpt-5.4", 1000, 500, 3)).toBe(40000);
  });

  it("searchCalls 缺省 → 与旧签名等价（不影响非搜索路径）", () => {
    expect(computeTrueCostMicros("gpt-5.4", 1000, 500)).toBe(computeTrueCostMicros("gpt-5.4", 1000, 500, 0));
  });
});

describe("checkGlobalBudget", () => {
  it("池内当日真实成本达预算 → overBudget true，SQL 按 tier 分池", async () => {
    const ctx = makeCtx({ firstBySql: [["SUM", { total: GLOBAL_BUDGET_MICROS.anonymous }]] });
    const over = await checkGlobalBudget(ctx, "anonymous", "2026-07-19");
    expect(over).toBe(true);
    expect(ctx.db.calls.sql[0]).toContain("usage_events");
    expect(ctx.db.calls.sql[0]).toContain("tier");
  });

  it("未达预算 → false", async () => {
    const ctx = makeCtx({ firstBySql: [["SUM", { total: 12 }]] });
    expect(await checkGlobalBudget(ctx, "user", "2026-07-19")).toBe(false);
  });

  it("预算读自 ctx.credits：宿主调低匿名池预算即按新值熔断", async () => {
    const ctx = makeCtx({ firstBySql: [["SUM", { total: 12 }]] });
    ctx.credits = { ...DEFAULT_CREDITS, globalBudgetMicros: { anonymous: 10, user: 10 } };
    expect(await checkGlobalBudget(ctx, "anonymous", "2026-07-19")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 配置对齐：数值与旧计数器体系一致，用户无感迁移
// ---------------------------------------------------------------------------

describe("配置", () => {
  it("日授予额与旧档位对齐（匿名 5 / 登录 10 / pro 100）", () => {
    expect(DAILY_GRANT).toEqual({ anonymous: 5, user: 10, pro: 100 });
  });

  it("费率表：普通对话 = 1 credit", () => {
    expect(RATE_CARD.chat).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// runBillingGate / settleUsage / nextGrantAtUTC：各计费 feature 共用的闸与结算
// ---------------------------------------------------------------------------

describe("nextGrantAtUTC", () => {
  it("返回次日 UTC 零点 ISO", () => {
    expect(nextGrantAtUTC("2026-07-19")).toBe("2026-07-20T00:00:00.000Z");
  });
});

describe("runBillingGate", () => {
  const IDENTITY = { id: 5, install_id: "dev-1", user_sub: null, balance: 5, last_grant_day: "2026-07-19", last_grant_tier: "anonymous" };

  it("全局池超预算 → quota_global + resetAt，且回调 onBlocked", async () => {
    const ctx = makeCtx({ firstBySql: [["SUM", { total: GLOBAL_BUDGET_MICROS.anonymous }]] });
    const request = new Request("https://x.test/api/chat");
    const waitUntil = vi.fn();
    const r = await runBillingGate(ctx, { installId: "dev-1", userSub: null, tier: "anonymous", feature: "chat", day: "2026-07-19", request, waitUntil });
    expect(r.error).toBe("quota_global");
    expect(r.resetAt).toBe("2026-07-20T00:00:00.000Z");
    expect(ctx.onBlocked).toHaveBeenCalledTimes(1);
    expect(ctx.onBlocked).toHaveBeenCalledWith({
      reason: "quota_global", tier: "anonymous", feature: "chat", installId: "dev-1", userSub: null, request, waitUntil,
    });
  });

  it("余额不足（charge changes=0）→ quota_device + resetAt，且回调 onBlocked", async () => {
    const ctx = makeCtx({
      runMeta: { changes: 0 },
      firstBySql: [["SUM", { total: 0 }], ["user_sub IS NULL", { ...IDENTITY, balance: 0 }]],
    });
    const r = await runBillingGate(ctx, { installId: "dev-1", userSub: null, tier: "anonymous", feature: "chat", day: "2026-07-19" });
    expect(r.error).toBe("quota_device");
    expect(r.resetAt).toBe("2026-07-20T00:00:00.000Z");
    expect(ctx.onBlocked).toHaveBeenCalledWith(expect.objectContaining({ reason: "quota_device", tier: "anonymous", feature: "chat", installId: "dev-1", userSub: null, request: null, waitUntil: null }));
  });

  it("放行 → 返回 identity 与已扣 credits，不回调 onBlocked", async () => {
    const ctx = makeCtx({ firstBySql: [["SUM", { total: 0 }], ["user_sub IS NULL", IDENTITY]] });
    const r = await runBillingGate(ctx, { installId: "dev-1", userSub: null, tier: "anonymous", feature: "chat", day: "2026-07-19" });
    expect(r.error).toBeUndefined();
    expect(r.identity!.id).toBe(5);
    expect(r.credits).toBe(RATE_CARD.chat);
    expect(ctx.onBlocked).not.toHaveBeenCalled();
  });

  it("onBlocked 抛错 → 吞掉，拦截结果照常返回", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = makeCtx({ firstBySql: [["SUM", { total: GLOBAL_BUDGET_MICROS.anonymous }]] });
    ctx.onBlocked.mockImplementation(() => { throw new Error("host boom"); });
    const r = await runBillingGate(ctx, { installId: "dev-1", userSub: null, tier: "anonymous", feature: "chat", day: "2026-07-19" });
    expect(r.error).toBe("quota_global");
    expect(err).toHaveBeenCalledWith(expect.stringContaining("onBlocked"), expect.anything());
  });

  it("onBlocked 未配置（null）→ 拦截照常", async () => {
    const ctx = makeCtx({ firstBySql: [["SUM", { total: GLOBAL_BUDGET_MICROS.anonymous }]] });
    (ctx as ChatContext).onBlocked = null;
    const r = await runBillingGate(ctx, { installId: "dev-1", userSub: null, tier: "anonymous", feature: "chat", day: "2026-07-19" });
    expect(r.error).toBe("quota_global");
  });

  it("rate card 读自 ctx.credits：宿主覆盖 chat 费率即按新值预扣", async () => {
    const ctx = makeCtx({ firstBySql: [["SUM", { total: 0 }], ["user_sub IS NULL", IDENTITY]] });
    ctx.credits = { ...DEFAULT_CREDITS, rateCard: { ...DEFAULT_CREDITS.rateCard, chat: 2 } };
    const r = await runBillingGate(ctx, { installId: "dev-1", userSub: null, tier: "anonymous", feature: "chat", day: "2026-07-19" });
    expect(r.credits).toBe(2);
  });
});

describe("settleUsage", () => {
  const IDENTITY = { id: 5 };

  it("ok=true → 记 ok 事件，含 token 与 true_cost，不退款", async () => {
    const ctx = makeCtx();
    await settleUsage(ctx, {
      identity: IDENTITY, tier: "user", feature: "chat", model: "gpt-5.4", credits: 1,
      usage: { prompt_tokens: 1000, completion_tokens: 500 }, ok: true, day: "2026-07-19",
    });
    expect(ctx.db.calls.sql.some((s: string) => s.includes("balance = balance + ?"))).toBe(false);
    const insertIdx = ctx.db.calls.sql.findIndex((s: string) => s.includes("INSERT INTO usage_events"));
    expect(insertIdx).not.toBe(-1);
    const binds = ctx.db.calls.binds[insertIdx];
    expect(binds[4]).toBe(1000); // tokens_in
    expect(binds[5]).toBe(500); // tokens_out
    expect(binds[6]).toBe(1); // credits
    expect(binds[7]).toBe(10000); // true_cost_micros（gpt-5.4 官方牌价 $2.50/$15）
    expect(binds[8]).toBe("ok");
  });

  it("usage 携带 search_calls → true_cost 计入 web_search 按次费", async () => {
    const ctx = makeCtx();
    await settleUsage(ctx, {
      identity: IDENTITY, tier: "user", feature: "chat_search", model: "gpt-5.4", credits: 3,
      usage: { prompt_tokens: 1000, completion_tokens: 500, search_calls: 2 }, ok: true, day: "2026-07-19",
    });
    const insertIdx = ctx.db.calls.sql.findIndex((s: string) => s.includes("INSERT INTO usage_events"));
    const binds = ctx.db.calls.binds[insertIdx];
    expect(binds[7]).toBe(30000); // token 10000μ$ + 2 次搜索 × 10000μ$
  });

  it("ok=false 且当日 → 退还预扣并记 aborted 事件（credits 与 cost 记 0）", async () => {
    const ctx = makeCtx();
    await settleUsage(ctx, {
      identity: IDENTITY, tier: "user", feature: "chat", model: "gpt-5.4", credits: 1,
      usage: null, ok: false, day: new Date().toISOString().slice(0, 10),
    });
    expect(ctx.db.calls.sql.some((s: string) => s.includes("balance = balance + ?"))).toBe(true);
    const insertIdx = ctx.db.calls.sql.findIndex((s: string) => s.includes("INSERT INTO usage_events"));
    const binds = ctx.db.calls.binds[insertIdx];
    expect(binds[6]).toBe(0);
    expect(binds[7]).toBe(0);
    expect(binds[8]).toBe("aborted");
  });

  it("ok=false 但跨 UTC 日 → 只留痕不退款（与 pending 路径同口径）", async () => {
    const ctx = makeCtx();
    await settleUsage(ctx, {
      identity: IDENTITY, tier: "user", feature: "chat", model: "gpt-5.4", credits: 1,
      usage: null, ok: false, day: "2020-01-01",
    });
    expect(ctx.db.calls.sql.some((s: string) => s.includes("balance = balance + ?"))).toBe(false);
    const insertIdx = ctx.db.calls.sql.findIndex((s: string) => s.includes("INSERT INTO usage_events"));
    expect(ctx.db.calls.binds[insertIdx][8]).toBe("aborted"); // 痕迹仍要留
  });
});

// ---------------------------------------------------------------------------
// reclaimOrphanedPending：pending 状态机的兜底出口
// 进程死在预扣与结算之间时，pending 行会永远挂着，credits 拿不回来。这组用例锁死回收的四条纪律。
// ---------------------------------------------------------------------------

describe("reclaimOrphanedPending 孤儿回收", () => {
  const TODAY = new Date().toISOString().slice(0, 10);
  // D1 的 datetime('now') 形态：UTC 'YYYY-MM-DD HH:MM:SS'，无时区后缀
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString().slice(0, 19).replace("T", " ");
  const pendingRow = (over: Record<string, unknown> = {}) => ({
    id: 11, identity_id: 5, feature: "chat", credits: 1, day: TODAY, created_at: ago(30), ...over,
  });
  const ctxWith = (rows: unknown[], opts: DBOpts = {}) => makeCtx({ allBySql: [["status = 'pending'", rows]], ...opts });
  // 退款语句总会被 prepare 并放进 batch，是否生效由 `changes() > 0` 在库里判定，
  // 所以只能断言「真正执行过」，不能断言「是否 prepare 过」。
  const refunded = (ctx: Ctx) => ctx.db.executed.some((s: string) => s.includes("balance = balance + ?"));

  // 回收查询必须在 SQL 层就按 feature 阈值筛掉未超时的行。
  // 否则长阈值 feature 的 pending 会占据 `ORDER BY created_at` 的最老名额，
  // 把 5 分钟就该回收的 chat 孤儿挤出 LIMIT 窗口。
  // 这条断言存在的意义：JS 侧还有一层 now-createdMs 判断会兜住结果，
  // 若不校验 SQL 本身，把过滤整段删掉也不会有任何用例失败（review 实测如此）。
  it("候选集在 SQL 层按 feature 阈值过滤，未超时的行不进 LIMIT 窗口", async () => {
    const ctx = ctxWith([]);
    await reclaimOrphanedPending(ctx);
    const sql = ctx.db.calls.sql.find((s: string) => s.includes("FROM usage_events"));
    expect(sql).toContain("feature = 'chat' AND created_at < datetime('now', '-5 minutes')");
    expect(sql).toContain("feature = 'chat_search' AND created_at < datetime('now', '-10 minutes')");
    expect(sql).toContain("feature = 'chat_image_generation' AND created_at < datetime('now', '-10 minutes')");
    expect(sql).toContain("feature NOT IN"); // 未知 feature 回落默认阈值
    expect(sql).toContain("ORDER BY created_at LIMIT ?");
  });

  it("SQL 阈值必须由 PENDING_TIMEOUT_MS 生成，不得写死（防常量与 SQL 漂移）", async () => {
    const ctx = ctxWith([]);
    await reclaimOrphanedPending(ctx);
    const sql = ctx.db.calls.sql.find((s: string) => s.includes("FROM usage_events"));
    for (const [feature, ms] of Object.entries(PENDING_TIMEOUT_MS)) {
      expect(sql).toContain(`feature = '${feature}' AND created_at < datetime('now', '-${Math.round(ms / 60000)} minutes')`);
    }
  });

  it("超时的 pending → 条件更新认领并退款", async () => {
    const ctx = ctxWith([pendingRow()]);
    expect(await reclaimOrphanedPending(ctx)).toEqual({ scanned: 1, reclaimed: 1, refunded: 1 });
    const claimSql = ctx.db.calls.sql.find((s: string) => s.includes("UPDATE usage_events"));
    expect(claimSql).toContain("status = 'pending'"); // 幂等锁，防与迟到 settle 重复退款
    expect(claimSql).toContain("credits = 0");
    expect(refunded(ctx)).toBe(true);
  });

  it("未超时 → 不认领不退款（在途请求不得误杀）", async () => {
    const ctx = ctxWith([pendingRow({ created_at: ago(1) })]);
    expect(await reclaimOrphanedPending(ctx)).toEqual({ scanned: 1, reclaimed: 0, refunded: 0 });
    expect(refunded(ctx)).toBe(false);
  });

  it("认领落败（settle 抢先改了状态）→ 绝不退款", async () => {
    const ctx = ctxWith([pendingRow()], { runMeta: { changes: 0 } });
    expect(await reclaimOrphanedPending(ctx)).toEqual({ scanned: 1, reclaimed: 0, refunded: 0 });
    expect(refunded(ctx)).toBe(false);
  });

  it("跨 UTC 日的 pending → 认领留痕但不退款（旧额度按不结转语义已作废）", async () => {
    const ctx = ctxWith([pendingRow({ day: "2020-01-01" })]);
    expect(await reclaimOrphanedPending(ctx)).toEqual({ scanned: 1, reclaimed: 1, refunded: 0 });
    expect(refunded(ctx)).toBe(false);
  });

  it("阈值按 feature 分档：7 分钟的 chat_search pending 仍在 10 分钟窗口内，不回收", async () => {
    const ctx = ctxWith([pendingRow({ feature: "chat_search", created_at: ago(7) })]);
    expect((await reclaimOrphanedPending(ctx)).reclaimed).toBe(0);
  });

  it("未知 feature → 回落默认阈值（10 分钟），30 分钟者照常回收", async () => {
    const ctx = ctxWith([pendingRow({ feature: "unknown_feature" })]);
    expect((await reclaimOrphanedPending(ctx)).reclaimed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// settleUsage 的 eventId 路径（pending → 终态）。
// 上面那组只覆盖 eventId==null 的旧路径；新路径才是 chat 的实际走向。
// ---------------------------------------------------------------------------

describe("settleUsage eventId 路径（pending → 终态）", () => {
  const IDENTITY = { id: 5 };
  const TODAY = new Date().toISOString().slice(0, 10);
  const bindsOf = (ctx: Ctx, frag: string) => {
    const idx = ctx.db.calls.sql.findIndex((s: string) => s.includes(frag));
    return idx === -1 ? null : ctx.db.calls.binds[idx];
  };
  const refunded = (ctx: Ctx) => ctx.db.executed.some((s: string) => s.includes("balance = balance + ?"));

  it("ok=true → 条件 UPDATE 回填 token 与 true_cost，绑定值精确", async () => {
    const ctx = makeCtx();
    await settleUsage(ctx, {
      identity: IDENTITY, tier: "user", feature: "chat", model: "gpt-5.4", credits: 1,
      usage: { prompt_tokens: 1000, completion_tokens: 500 }, ok: true, day: TODAY, eventId: 42,
    });
    expect(ctx.db.calls.sql.some((s: string) => s.includes("INSERT INTO usage_events"))).toBe(false);
    const sql = ctx.db.calls.sql.find((s: string) => s.includes("status = 'ok'"));
    expect(sql).toContain("status = 'pending'"); // 幂等锁
    const b = bindsOf(ctx, "status = 'ok'");
    expect(b).toEqual(["gpt-5.4", 1000, 500, 10000, 1, 42]); // model, in, out, true_cost, credits, 行 id
    expect(refunded(ctx)).toBe(false);
  });

  it("chat_image_generation 出了图 → 全额 10 credits，成本含按张费", async () => {
    const ctx = makeCtx();
    await settleUsage(ctx, {
      identity: IDENTITY, tier: "pro", feature: "chat_image_generation", model: "gpt-5.6-luna", credits: 10,
      usage: { prompt_tokens: 1000, completion_tokens: 100, image_generation_calls: 1 }, ok: true, day: TODAY, eventId: 42,
    });
    const b = bindsOf(ctx, "status = 'ok'");
    // luna：0.2 + 0.12 = 0.32 → ceil 320μ$；加一张图 20_000μ$
    expect(b).toEqual(["gpt-5.6-luna", 1000, 100, 20320, 10, 42]);
    expect(refunded(ctx)).toBe(false);
  });

  it("chat_image_generation 但模型没出图 → 只计 1 credit，同批退还 9", async () => {
    const ctx = makeCtx();
    await settleUsage(ctx, {
      identity: IDENTITY, tier: "pro", feature: "chat_image_generation", model: "gpt-5.6-luna", credits: 10,
      usage: { prompt_tokens: 1000, completion_tokens: 100, image_generation_calls: 0 }, ok: true, day: TODAY, eventId: 42,
    });
    const b = bindsOf(ctx, "status = 'ok'")!;
    expect(b[4]).toBe(1);
    expect(refunded(ctx)).toBe(true);
    expect(bindsOf(ctx, "balance = balance + ?")).toEqual([9, IDENTITY.id]);
  });

  it("chat_image_generation 没出图但跨 UTC 日 → 只计 1 但不退（不结转口径）", async () => {
    const ctx = makeCtx();
    await settleUsage(ctx, {
      identity: IDENTITY, tier: "pro", feature: "chat_image_generation", model: "gpt-5.6-luna", credits: 10,
      usage: { prompt_tokens: 10, completion_tokens: 10, image_generation_calls: 0 }, ok: true, day: "2000-01-01", eventId: 42,
    });
    expect(bindsOf(ctx, "status = 'ok'")![4]).toBe(1);
    expect(refunded(ctx)).toBe(false);
  });

  it("ok=false 且当日 → aborted 保留 token（成本归因不丢），并在同批退款", async () => {
    const ctx = makeCtx();
    await settleUsage(ctx, {
      identity: IDENTITY, tier: "user", feature: "chat", model: "gpt-5.4", credits: 1,
      usage: { prompt_tokens: 800, completion_tokens: 200 }, ok: false, day: TODAY, eventId: 43,
    });
    const b = bindsOf(ctx, "status = 'aborted'");
    // 失败也已烧掉 token，必须留痕；调用方未给原因 → 'unknown'（NULL 留给改造前的历史行）
    expect(b).toEqual(["gpt-5.4", 800, 200, "unknown", 43]);
    const refundSql = ctx.db.calls.sql.find((s: string) => s.includes("balance = balance + ?"));
    expect(refundSql).toContain("changes() > 0"); // 认领成功才退，且与认领同批
    expect(refunded(ctx)).toBe(true);
  });

  it("ok=false 但跨 UTC 日 → 只留痕不退款（旧额度已作废）", async () => {
    const ctx = makeCtx();
    await settleUsage(ctx, {
      identity: IDENTITY, tier: "user", feature: "chat", model: "gpt-5.4", credits: 1,
      usage: null, ok: false, day: "2020-01-01", eventId: 44,
    });
    expect(bindsOf(ctx, "status = 'aborted'")).toEqual(["gpt-5.4", 0, 0, "unknown", 44]);
    expect(ctx.db.calls.sql.some((s: string) => s.includes("balance = balance + ?"))).toBe(false);
  });

  it("failReason 透传到 aborted 行 —— 上游失败与客户端断流从此可分", async () => {
    const ctx = makeCtx();
    await settleUsage(ctx, {
      identity: IDENTITY, tier: "user", feature: "chat", model: "gpt-5.6-luna", credits: 1,
      usage: null, ok: false, day: TODAY, eventId: 45, failReason: "client_abort",
    });
    expect(bindsOf(ctx, "status = 'aborted'")).toEqual(["gpt-5.6-luna", 0, 0, "client_abort", 45]);
  });

  it("ok=true → 不写 fail_reason（成功行不该带失败语义）", async () => {
    const ctx = makeCtx();
    await settleUsage(ctx, {
      identity: IDENTITY, tier: "user", feature: "chat", model: "gpt-5.4", credits: 1,
      usage: { prompt_tokens: 10, completion_tokens: 5 }, ok: true, day: TODAY, eventId: 46,
      failReason: "client_abort", // 即便调用方误传也应被忽略
    });
    const okSql = ctx.db.calls.sql.find((s: string) => s.includes("status = 'ok'"));
    expect(okSql).not.toContain("fail_reason");
  });

  it("ok=true 认领落败（回收 cron 抢先判死）→ 告警，成本不静默丢失", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = makeCtx({ runMeta: { changes: 0 } });
    await settleUsage(ctx, {
      identity: IDENTITY, tier: "user", feature: "chat", model: "gpt-5.4", credits: 1,
      usage: { prompt_tokens: 10, completion_tokens: 20 }, ok: true, day: TODAY, eventId: 45,
    });
    expect(err).toHaveBeenCalledWith(expect.stringContaining("lost race with reclaim"), expect.anything());
  });
});

// ---------------------------------------------------------------------------
// runBillingGate 的双向不变量守卫
// ---------------------------------------------------------------------------

describe("runBillingGate 不变量守卫", () => {
  const IDENTITY = { id: 5, install_id: "dev-1", user_sub: null, balance: 10, last_grant_day: "2026-07-19", last_grant_tier: "anonymous" };
  const baseCtx = (opts?: DBOpts) => makeCtx({
    firstBySql: [["SUM", { total: 0 }], ["user_sub IS NULL", IDENTITY]],
    ...opts,
  });

  it("扣款成功但 pending 未落 → 告警且 eventId 置空（绝不返回可能指向别行的 rowid）", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = baseCtx();
    // 让 INSERT 的 changes 为 0，模拟 changes() 语义与预期不符的极端情形
    ctx.db.run = vi.fn(async (sql: string = "") => (sql.includes("INSERT INTO usage_events")
      ? { meta: { changes: 0, last_row_id: 999 } } // 999 是同连接上别人的 rowid
      : { meta: { changes: 1 } }));
    const r = await runBillingGate(ctx, { installId: "dev-1", userSub: null, tier: "anonymous", feature: "chat", day: "2026-07-19" });
    expect(r.error).toBeUndefined();
    expect(r.eventId).toBeNull();
    expect(err).toHaveBeenCalledWith(expect.stringContaining("pending row missing"), expect.anything());
  });

  it("扣款失败却留下 pending 行 → 告警（凭空造币方向）", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = baseCtx();
    ctx.db.run = vi.fn(async (sql: string = "") => (sql.includes("INSERT INTO usage_events")
      ? { meta: { changes: 1, last_row_id: 7 } }
      : { meta: { changes: 0 } })); // 扣款未生效
    // batch 的 mock 会因首条 changes=0 而挡下 INSERT，这里绕过它直接验证守卫分支
    ctx.db.batch = vi.fn(async () => [
      { meta: { changes: 0 } },
      { meta: { changes: 1, last_row_id: 7 } },
    ]);
    const r = await runBillingGate(ctx, { installId: "dev-1", userSub: null, tier: "anonymous", feature: "chat", day: "2026-07-19" });
    expect(r.error).toBe("quota_device");
    expect(err).toHaveBeenCalledWith(expect.stringContaining("without a charge"), expect.anything());
  });
});

describe("resolveIdentity 并发安全", () => {
  it("升级 UPDATE 带 AND user_sub IS NULL 守卫；竞争落败（changes=0）→ 重读用户主体行", async () => {
    const deviceRow = { id: 5, install_id: "dev-1", user_sub: null, balance: 2, last_grant_day: "2026-07-19" };
    const userRow = { id: 5, install_id: "dev-1", user_sub: "user_u9", balance: 10, last_grant_day: "2026-07-20" };
    let promoted = false;
    const ctx = makeCtx({
      runMeta: { changes: 0 }, // 模拟另一并发请求已完成升级
      firstBySql: [
        ["user_sub = ?", null],
        ["user_sub IS NULL", deviceRow],
      ],
    });
    // 竞争落败后的重读返回已升级行
    const origFirst = ctx.db.first;
    ctx.db.first = vi.fn(async () => {
      const sql = ctx.db.calls.sql.at(-1)!;
      if (promoted && sql.includes("user_sub = ?")) return userRow;
      if (sql.includes("UPDATE")) return null;
      const r = await origFirst();
      if (sql.includes("user_sub IS NULL")) promoted = true;
      return r;
    });
    const identity = await resolveIdentity(ctx, { installId: "dev-1", userSub: "user_u9" });
    const promoteSql = ctx.db.calls.sql.find((s: string) => s.includes("UPDATE identities") && s.includes("user_sub"));
    expect(promoteSql).toContain("user_sub IS NULL");
    expect(identity.user_sub).toBe("user_u9");
    expect(identity.balance).toBe(10); // 来自重读，而非本地拼接
  });

  it("INSERT 撞唯一索引（并发建行）→ 捕获后重读已存在的行", async () => {
    const existing = { id: 9, install_id: "dev-n", user_sub: null, balance: 5, last_grant_day: "2026-07-20" };
    let inserted = false;
    const ctx = makeCtx();
    ctx.db.first = vi.fn(async () => {
      const sql = ctx.db.calls.sql.at(-1)!;
      if (sql.includes("INSERT INTO identities")) {
        inserted = true;
        throw new Error("UNIQUE constraint failed: identities.install_id");
      }
      if (sql.includes("user_sub IS NULL")) return inserted ? existing : null;
      return null;
    });
    const identity = await resolveIdentity(ctx, { installId: "dev-n", userSub: null });
    expect(identity).toEqual(existing);
  });
});

describe("ensureDailyGrant 档位变化重授", () => {
  it("同日但档位从 user 升 pro → 重授 100（付费当日立即生效）", async () => {
    const identity = { id: 5, balance: 3, last_grant_day: "2026-07-19", last_grant_tier: "user" } as Identity;
    const ctx = makeCtx();
    const updated = await ensureDailyGrant(ctx, identity, "pro", "2026-07-19");
    expect(updated.balance).toBe(DAILY_GRANT.pro);
    expect(ctx.db.calls.sql.some((s: string) => s.includes("INSERT INTO credit_grants"))).toBe(true);
  });

  it("同日同档位 → 仍然短路不写库", async () => {
    const identity = { id: 5, balance: 3, last_grant_day: "2026-07-19", last_grant_tier: "user" } as Identity;
    const ctx = makeCtx();
    const updated = await ensureDailyGrant(ctx, identity, "user", "2026-07-19");
    expect(updated.balance).toBe(3);
    expect(ctx.db.calls.sql.length).toBe(0);
  });

  it("授予额读自 ctx.credits：宿主覆盖 user 档即按新值授予", async () => {
    const identity = { id: 5, balance: 0, last_grant_day: "2026-07-18" } as Identity;
    const ctx = makeCtx();
    ctx.credits = { ...DEFAULT_CREDITS, dailyGrant: { ...DEFAULT_CREDITS.dailyGrant, user: 42 } };
    const updated = await ensureDailyGrant(ctx, identity, "user", "2026-07-19");
    expect(updated.balance).toBe(42);
    expect(ctx.db.calls.binds[0][0]).toBe(42);
  });
});
