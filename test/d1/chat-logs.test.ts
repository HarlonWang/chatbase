import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { purgeChatLogs } from "../../src/chat-logs.js";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const ctx = (logRetentionDays: number | null) => ({ db: env.DB, logRetentionDays });

const insert = (day: string, n = 1) => env.DB.batch(Array.from({ length: n }, () => env.DB.prepare(
  "INSERT INTO chat_logs (install_id, day, created_at, content) VALUES ('dev-1', ?, ?, 'q')",
).bind(day, `${day}T00:00:00.000Z`)));
const days = () => env.DB.prepare("SELECT day FROM chat_logs ORDER BY day").all<{ day: string }>().then((r) => r.results.map((x) => x.day));

beforeEach(() => env.DB.prepare("DELETE FROM chat_logs").run());

describe("purgeChatLogs：按 day 删超期行", () => {
  it("保留 90 天：day ≤ 今天-90 的删除，之后的保留", async () => {
    await insert("2026-07-14"); // 今天-91
    await insert("2026-07-15"); // 今天-90：到期当天删
    await insert("2026-07-16"); // 今天-89
    await insert("2026-10-13");
    expect(await purgeChatLogs(ctx(90), { now: NOW })).toEqual({ deleted: 2 });
    expect(await days()).toEqual(["2026-07-16", "2026-10-13"]);
  });

  it("未配保留天数：不删任何行", async () => {
    await insert("2020-01-01");
    expect(await purgeChatLogs(ctx(null), { now: NOW })).toEqual({ deleted: 0 });
    expect(await days()).toEqual(["2020-01-01"]);
  });

  it("单次至多删 limit 行，积压由后续轮次消化", async () => {
    await insert("2026-01-01", 5);
    expect(await purgeChatLogs(ctx(90), { now: NOW, limit: 3 })).toEqual({ deleted: 3 });
    expect(await purgeChatLogs(ctx(90), { now: NOW, limit: 3 })).toEqual({ deleted: 2 });
    expect(await purgeChatLogs(ctx(90), { now: NOW, limit: 3 })).toEqual({ deleted: 0 });
  });
});
