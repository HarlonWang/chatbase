// chat_logs 的保留策略：按 day 列（UTC 'YYYY-MM-DD'，有 idx_chat_logs_day）分批删超期行。
// 与账本回收（credits.ts 的 reclaim）分开：一个是钱，一个是清理，失败互不牵连。

import type { ChatContext } from "./config.js";

export interface PurgeResult {
  deleted: number;
}

/** 每次最多删 limit 行，控制单次 cron 耗时；积压由后续轮次消化。未配保留天数时不碰表 */
export async function purgeChatLogs(
  ctx: Pick<ChatContext, "db" | "logRetentionDays">,
  { limit = 1000, now = Date.now() }: { limit?: number; now?: number } = {},
): Promise<PurgeResult> {
  if (ctx.logRetentionDays == null) return { deleted: 0 };
  const cutoff = new Date(now - ctx.logRetentionDays * 86_400_000).toISOString().slice(0, 10);
  const res = await ctx.db.prepare(
    "DELETE FROM chat_logs WHERE id IN (SELECT id FROM chat_logs WHERE day <= ? ORDER BY id LIMIT ?)",
  ).bind(cutoff, limit).run();
  return { deleted: res.meta.changes ?? 0 };
}
