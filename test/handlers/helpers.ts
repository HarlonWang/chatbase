import { vi } from "vitest";
import { resolveContext, type ChatConfig, type ChatContext, type Tier, type TierInfo } from "../../src/config.js";
import { renderItemContext } from "../../src/chat/input.js";
import { todayUTC } from "../../src/http.js";

export const TODAY = todayUTC();

export interface UserIdentityOpts {
  balance?: number;
  last_grant_tier?: string;
  [key: string]: unknown;
}

export interface FakeDBOpts {
  /** 设备主体当前余额（last_grant_day=今日 → 不触发懒授予） */
  balance?: number;
  /** 当日池内真实成本合计（美元熔断判定用） */
  globalCostMicros?: number;
  /** 登录用户主体行；缺省走「升级 + 重授」路径 */
  userIdentity?: UserIdentityOpts | null;
}

// 账本模型的 SQL 路由型 D1 fake（轻量状态机）：
// 扣减 / 授予按真实 SQL 语义模拟——charge 依当前余额判定 changes，grant SET 余额。
// db.bind 只用于按 prepare 序号取绑定参数（与 prepare 一一对应）。
export const makeDB = ({ balance = 5, globalCostMicros = 0, userIdentity = null }: FakeDBOpts = {}) => {
  let currentBalance = balance;
  let eventSeq = 0;
  const calls = { sql: [] as string[] };
  const bind = vi.fn();

  const runSql = (sql: string, binds: any[]) => {
    if (sql.includes("balance = balance - ?")) {
      const ok = currentBalance >= binds[0];
      if (ok) currentBalance -= binds[0];
      return { meta: { changes: ok ? 1 : 0 } };
    }
    if (sql.includes("last_grant_day = ?")) {
      currentBalance = binds[0];
      return { meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO usage_events")) {
      return { meta: { changes: 1, last_row_id: ++eventSeq } };
    }
    return { meta: { changes: 1 } };
  };

  const firstSql = (sql: string, binds: any[]) => {
    if (sql.includes("SUM(true_cost_micros")) return { total: globalCostMicros };
    if (sql.includes("user_sub = ?")) {
      if (!userIdentity) return null;
      currentBalance = userIdentity.balance ?? currentBalance;
      return { id: 2, install_id: "dev-1", user_sub: "u", balance: currentBalance, last_grant_day: TODAY, last_grant_tier: "user", ...userIdentity };
    }
    if (sql.includes("user_sub IS NULL") || sql.includes("INSERT INTO identities")) {
      return { id: 1, install_id: binds[0], user_sub: null, balance: currentBalance, last_grant_day: TODAY, last_grant_tier: "anonymous" };
    }
    return null;
  };

  const makeStmt = (sql: string) => {
    calls.sql.push(sql);
    let binds: any[] = [];
    const stmt: any = {
      sql,
      bind: vi.fn((...args: any[]) => { binds = args; bind(...args); return stmt; }),
      run: vi.fn(async () => db.run(sql, binds)),
      first: vi.fn(async () => firstSql(sql, binds)),
      all: vi.fn(async () => ({ results: [] })),
    };
    return stmt;
  };

  const db = {
    calls,
    bind,
    // 独立成 db 级方法，便于测试覆写注入故障
    run: vi.fn(async (sql: string, binds: any[]) => runSql(sql, binds)),
    prepare: vi.fn(makeStmt),
    // 复现 D1 batch 语义：顺序执行，`WHERE changes() > 0` 读上一条语句的影响行数
    batch: vi.fn(async (stmts: any[]) => {
      const out: any[] = [];
      let lastChanges = 0;
      for (const stmt of stmts) {
        if (stmt.sql.includes("changes() > 0") && lastChanges === 0) {
          out.push({ meta: { changes: 0, last_row_id: 0 } });
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

export type FakeDB = ReturnType<typeof makeDB>;

export const tierInfo = (tier: Tier, userSub = "u1"): TierInfo =>
  tier === "anonymous" ? { tier } : { tier, userSub };

export interface MakeCtxOpts {
  db?: FakeDBOpts;
  /** 档位裁决结果；默认匿名 */
  tier?: TierInfo;
  providers?: ChatConfig["providers"];
  images?: unknown;
  kv?: unknown;
  basePath?: string;
  config?: Partial<ChatConfig>;
}

export type TestCtx = ChatContext & {
  db: FakeDB;
  resolveTier: ReturnType<typeof vi.fn>;
  onBlocked: ReturnType<typeof vi.fn>;
};

export const makeCtx = ({ db, tier, providers = { openai: { apiKey: "sk-test" } }, images, kv, basePath = "/api", config = {} }: MakeCtxOpts = {}): TestCtx =>
  resolveContext({
    db: makeDB(db) as unknown as D1Database,
    providers,
    resolveTier: vi.fn(async (): Promise<TierInfo> => tier ?? { tier: "anonymous" }),
    prompt: { brand: "TrendingAI", context: renderItemContext },
    onBlocked: vi.fn(),
    ...(images ? { images: images as R2Bucket } : {}),
    ...(kv ? { kv: kv as KVNamespace } : {}),
    ...config,
  }, basePath) as TestCtx;

export const fakeR2 = () => ({ put: vi.fn(async () => {}), get: vi.fn() });

export const EXEC = () => ({ waitUntil: vi.fn() }) as unknown as ExecutionContext;

/** 在 prepare 调用里找含指定片段的 SQL 对应的 bind 参数 */
export const findBound = (db: FakeDB, sqlFragment: string): any[] | null => {
  const idx = db.prepare.mock.calls.findIndex(([sql]) => sql.includes(sqlFragment));
  return idx === -1 ? null : db.bind.mock.calls[idx];
};

export const hasSql = (db: FakeDB, fragment: string) => db.prepare.mock.calls.some(([sql]) => sql.includes(fragment));

// Responses API 非流式返回形态
export const openaiJson = (content: string) => ({
  output: [{ type: "message", content: [{ type: "output_text", text: content }] }],
  usage: { input_tokens: 10, output_tokens: 5 },
});

export const stubFetchOk = (content = "hello") =>
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => openaiJson(content) }));

/** Responses API SSE 上游：每条 line 是一个事件 JSON 串 */
export const sseUpstream = (lines: string[]): Response => {
  const enc = new TextEncoder();
  return new Response(new ReadableStream({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(`data: ${l}\n\n`));
      c.close();
    },
  }), { status: 200 });
};

export const textStreamLines = (texts: string[], usage: Record<string, number> = { input_tokens: 10, output_tokens: 5 }) => [
  ...texts.map((t) => JSON.stringify({ type: "response.output_text.delta", delta: t })),
  JSON.stringify({ type: "response.completed", response: { usage } }),
];

/** workers-types 下 Response.json() 是 unknown；测试只关心形状 */
export const json = (res: Response): Promise<any> => res.json();

export const parseFrames = (text: string) =>
  text.split("\n\n").filter(Boolean).map((b) => JSON.parse(b.replace(/^data: /, "")));
