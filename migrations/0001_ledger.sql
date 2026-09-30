-- 计费「账本 + 授予」双层模型。balance 是缓存列，真相 = Σcredit_grants − Σusage_events。
-- identities：匿名 = 设备主体（install_id，user_sub IS NULL）；登录 = 用户主体（user_sub）。
-- 部分唯一索引允许「同 install 先匿名后登录」共存两行。

CREATE TABLE IF NOT EXISTS identities (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    install_id      TEXT,
    user_sub        TEXT,
    balance         INTEGER NOT NULL DEFAULT 0,
    last_grant_day  TEXT,                 -- UTC 'YYYY-MM-DD'；懒授予去重键，登录升级时清空以按新档重授
    last_grant_tier TEXT,                 -- 上次授予的档位；同日升 Pro 时依此按新档重授
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_identities_device ON identities(install_id) WHERE user_sub IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_identities_user   ON identities(user_sub)   WHERE user_sub IS NOT NULL;

CREATE TABLE IF NOT EXISTS credit_grants (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    identity_id INTEGER NOT NULL,
    amount      INTEGER NOT NULL,
    reason      TEXT NOT NULL,            -- 'daily_anonymous' | 'daily_user' | 'daily_pro' | ...
    day         TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_grants_identity ON credit_grants(identity_id);

-- 出账明细，双币种：credits（用户侧扣减单位）+ true_cost_micros（平台侧真实成本，微美元）。
-- status：'pending'（预扣未结算）| 'ok' | 'aborted'（失败退还，留痕不计费）。
-- fail_reason 只在 aborted 时有意义：upstream_error | upstream_timeout | upstream_region_blocked | client_abort | reclaimed
CREATE TABLE IF NOT EXISTS usage_events (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    identity_id      INTEGER NOT NULL,
    tier             TEXT NOT NULL,
    feature          TEXT NOT NULL,
    model            TEXT,
    tokens_in        INTEGER NOT NULL DEFAULT 0,
    tokens_out       INTEGER NOT NULL DEFAULT 0,
    credits          INTEGER NOT NULL,
    true_cost_micros INTEGER NOT NULL DEFAULT 0,
    status           TEXT NOT NULL DEFAULT 'ok',
    day              TEXT NOT NULL,
    fail_reason      TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_events_day          ON usage_events(day);
CREATE INDEX IF NOT EXISTS ix_events_identity_day ON usage_events(identity_id, day);
CREATE INDEX IF NOT EXISTS idx_usage_events_pending ON usage_events(status, created_at);
