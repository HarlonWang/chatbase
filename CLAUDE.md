# chatbase

多 App 共用的 AI chat 底座：多厂商模型调用、SSE 流、账本计费、模型目录，以 Hono 子应用工厂发布为 npm 包 `@whlong/chatbase`，挂进宿主自己的 Cloudflare Worker，数据落宿主自己的 D1。与 loginbase / eventbase 同型。

**开工前先读 README.md 和 `docs/chat-protocol.md`**（线上协议，客户端 SDK 的唯一权威）。抽取方案与边界在 `~/TonoChatProjects/chatbase-抽取方案.md`，宿主接入说明在 `~/TonoChatProjects/chatbase-接入说明.md`。

## 关联仓库

| 路径 | 角色 |
|---|---|
| `~/TrendingProjects/github-ai-trending-api` | **源头与首个宿主**：本仓从它的 `src/lib/{providers,llm,models,sse,stream-parse,credits,chat/*}.js` 与 `src/api/{chat,chat-models,chat-transcribe,quota,generated-image}.js` 抽出；切换后它改为依赖本包 |
| `~/TonoChatProjects` | 第二个宿主 Tono 的总览与文档 |
| `~/TrendingProjects/TrendingAI/chat` → `HarlonWang/chatbase-kmp` | 客户端 SDK（KMP + CMP），协议以本仓 `docs/chat-protocol.md` 为准，客户端仓不留副本 |
| `~/loginbase`、`~/eventbase` | 姊妹底座，工程结构与发布流程照它们 |

## 铁律

- **本库不持有用户与订阅**。档位只从宿主的 `resolveTier` 拿，库内没有任何读用户表、订阅表的代码。要加「按用户」的逻辑，先停下来问。
- **协议变更纪律**：`docs/chat-protocol.md` 是唯一权威且只住本仓。服务端实现与协议文档必须同一个 commit，同时在 `chatbase-kmp` 仓开跟进 issue，客户端版本落地前不关。
- **账本语义不漂移**：`src/credits.ts` 的 SQL、batch 顺序、幂等锁是钱，改动必须有 `test/d1/` 真 D1 测试覆盖。
- **厂商差异只住 `src/providers.ts`（数据）与 `src/chat/policy.ts`（裁决）**，公共层不做协议翻译。
- 依赖准入同 loginbase：现有基座（hono）、业界权威库、自己的库（peerDependency）；其余先问。
- 发布走 tag 触发 CI + npm trusted publishing，registry 是唯一分发路径。

## 工程

- `npm run typecheck && npm run build && npm test`；测试分 unit（mock D1）与 d1（workerd 真 D1）两个 project
- 迁移在 `migrations/`，编号从 0001 起；TrendingAI 已按旧编号建过表，切换时不重跑
