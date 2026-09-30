-- 用户问题留痕（产品洞察 + 滥用监测）。只存每轮用户新问题原文，不存助手回复；
-- 记录点在配额检查之前，被限流 / 上游报错的请求也留痕。

CREATE TABLE IF NOT EXISTS chat_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    install_id  TEXT NOT NULL,
    day         TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    content     TEXT NOT NULL,
    lang        TEXT,
    has_context INTEGER NOT NULL DEFAULT 0,
    image_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_chat_logs_install_day ON chat_logs(install_id, day);
CREATE INDEX IF NOT EXISTS idx_chat_logs_day         ON chat_logs(day);
