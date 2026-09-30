# AI Chat 线上协议

> **本文是客户端 chat SDK 与服务端之间的唯一权威**：服务端实现与本文必须同一个 commit 落地，客户端仓（TrendingAI `:chat` 模块）不留副本，只留一行指针。
> 变更规则见「兼容策略」。凡带 **[v2 新增]** 标记的条目随多厂商接入一起上线（方案见 TrendingProjects `ai-多厂商-方案.md`）；带 **[v3 新增]** 的随图片生成一起上线（方案见 TrendingProjects `ai-chat-图片生成-方案.md`）。未标记的即当前线上行为。
>
> 版本 **1.0**（2026-09-08 按线上现状整理）。

## 端点

| 方法 | 路径 | 鉴权 | 用途 |
|---|---|---|---|
| `GET` | `/api/chat/models` | 无 | 模型目录，供选择器渲染 |
| `POST` | `/api/chat` | 可选 Bearer | 对话（流式 SSE 或一次性 JSON） |
| `POST` | `/api/chat/transcribe` | 可选 Bearer，实际要求 Pro | 语音转写，只吐文本 |
| `GET` | `/api/chat/generated-images/:key` **[v3 新增]** | 无 | 回吐生成图（见下） |

生产域名 `https://api.trendingai.cn`。所有端点响应 CORS 头并接受 `OPTIONS` 预检。

## `GET /api/chat/generated-images/:key` **[v3 新增]**

回吐一张生成图（JPEG）。`key` 是服务端签发的随机 uuid 文件名，不可猜即访问控制，无需鉴权头——它要能被 Markdown 图片渲染器直接加载。内容不可变，`Cache-Control: public, max-age=31536000, immutable`。不存在或形状不合法一律 404。

## 请求头

| 头 | 端点 | 必传 | 说明 |
|---|---|---|---|
| `X-Install-Id` | chat、transcribe | 是 | 安装标识，匿名档的配额键；缺失返回 400 `missing_install_id` |
| `Authorization: Bearer <token>` | chat、transcribe | 否 | loginbase 访问令牌。带且有效 → 登录档或 Pro 档；带但无效 → 401 `auth_invalid`；校验服务不可用时降级匿名档放行 |
| `Content-Type` | chat | 是 | `application/json` |
| `Content-Type` | transcribe | 是 | `multipart/form-data` |

## 档位（tier）

服务端按请求头解析，客户端不能指定：`anonymous`（无有效令牌）、`user`（有效令牌）、`pro`（有效令牌且订阅或赞助生效）。档位决定：可用模型、日额度、是否能发图（`user` 起）、是否能用语音（`pro`）。

## `GET /api/chat/models`

响应 `200`，可缓存 300 秒：

```json
{
    "default": "gpt-5.6-luna",
    "models": [
        {
            "id": "gpt-5.6-luna",
            "name": "GPT-5.6 Luna",
            "minTier": "user",
            "provider": "openai",
            "providerName": "OpenAI",
            "caps": { "images": true, "search": true, "imageGeneration": true }
        }
    ]
}
```

| 字段 | 说明 |
|---|---|
| `default` | 请求不带 `model` 时服务端实际使用的 id，必然出现在 `models` 里 |
| `models[].id` | 请求 `model` 字段的取值 |
| `models[].name` | 展示名 |
| `models[].minTier` | `user` 或 `pro`。`user` 表示所有档位可用（含匿名） |
| `models[].provider` **[v2 新增]** | 厂商 id：`openai`、`deepseek`、`zhipu`。客户端按此分组，新厂商会随目录出现，不得硬编码枚举 |
| `models[].providerName` **[v2 新增]** | 厂商展示名，用于选择器分组标题与出处标注 |
| `models[].caps` **[v2 新增]** | 该模型的能力：`images` 可附图、`search` 可开联网搜索、`imageGeneration` **[v3 新增]** 可开图片生成。客户端据此隐藏或置灰入口；`images` / `search` 缺省视为 `true`，**`imageGeneration` 缺省视为 `false`**（旧服务端不下发时不得凭空亮入口） |

目录为动态内容：新模型可能随时出现或消失。客户端不得硬编码模型 id；持久化的手选 id 若不在目录中，按 `default` 处理。

## `POST /api/chat`

### 请求体

```json
{
    "messages": [
        { "role": "user", "content": "..." },
        { "role": "assistant", "content": "..." },
        { "role": "user", "content": [
            { "type": "text", "text": "这张图是什么" },
            { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,..." } }
        ] }
    ],
    "lang": "zh",
    "model": "gpt-5.6-luna",
    "stream": true,
    "search": false,
    "imageGeneration": false
}
```

| 字段 | 必传 | 说明 |
|---|---|---|
| `messages` | 是 | 非空数组，`role` 只能是 `user` / `assistant`，末条必须是 `user`。服务端只取最近 12 条且总字符不超 16000，超出从最旧端丢弃 |
| `messages[].content` | 是 | `assistant` 只能是字符串；`user` 可以是字符串或 parts 数组。parts 只接受 `text` 与 `image_url`，图片只接受 `data:image/(jpeg\|png\|webp);base64,` 内嵌形式，不接受 http URL |
| `lang` | 否 | `zh` 用中文，其余一律英文 |
| `model` | 否 | 目录里的 id。缺省回落 `default`。免费档只接受免费白名单内的 id，其余回落 `default`；Pro 档按服务端准入规则放行（每家厂商各有一条 id 形状规则，OpenAI 另有最低版本阈值；厂商改名后的旧 id 经别名表换成正式 id 再裁决，账本与响应都记正式 id），目录是该规则的展示结果而非判据，形状合法但上游不存在或已退役的 id 会直接失败并返回 502 `upstream_error`，额度退还。客户端应只发送当前目录里的 id |
| `stream` | 否 | `true` 走 SSE；缺省或 `false` 返回一次性 JSON（旧形态，退役观察中，新客户端必须传 `true`） |
| `search` | 否 | `true` 开联网搜索，按搜索费率计额度。**仅 Pro**（非 Pro 档 403 `search_requires_pro`，客户端应在开启前已拦） |
| `imageGeneration` **[v3 新增]** | 否 | `true` 开图片生成：服务端给所选模型挂 `image_generation` 工具，由模型判断生成或编辑。**仅 Pro、仅流式、仅 `caps.imageGeneration` 的模型**。按图片生成费率预扣（10）；模型最终未出图时只按普通对话计并退还差额，`done` 后以 `/api/quota` 为准。**与 `search` 互斥**：同时为 `true` 时服务端忽略 `search`（单条消息只挂生图工具、最多一张图），客户端应把两个开关做成互斥。开启时若末条消息未附图，服务端会把历史里最近一张本服务签发的生成图（`/api/chat/generated-images/…`）作为参考图带回上游，使「换个背景」这类跟进能编辑上一张 |

单条用户消息文本上限 4000 字符。图片只允许出现在末条消息；单张 base64 长度上限约 500 KB；张数与总体积上限由 `/api/app-config` 的 `chat_images` 下发（`max_count`、`per_image_jpeg_kb`），宿主读取后经 `ChatHost` 交给 SDK 做发送前预检。

### 流式响应（`stream: true`）

`200`，`Content-Type: text/event-stream`。每帧一行 `data: <JSON>` 加空行，帧类型按 JSON 里出现的键区分，**未知键必须忽略**：

| 帧 | 形状 | 说明 |
|---|---|---|
| 增量 | `{"delta":"..."}` | 正文增量，按顺序拼接 |
| 搜索开始 | `{"search":{"state":"started"}}` | 一次搜索调用开始；一条消息内可多次 |
| 搜索完成 | `{"search":{"state":"done","query":"..."}}` | `query` 可缺省 |
| 来源 | `{"source":{"title":"...","url":"..."}}` | 搜索引用的来源，按 url 去重后逐条下发，可能为零条 |
| 生图进度 **[v3 新增]** | `{"imageGeneration":{"state":"generating"}}` / `{"imageGeneration":{"state":"done"}}` | 一次图片生成开始 / 完成（`done` 紧接在图片 delta 之前）；一条消息内最多一次。**生成的图片不单独成帧**：以 Markdown 图片 `\n\n![](https://…/api/chat/generated-images/<uuid>.jpg)\n\n` 作为普通 `delta` 下发，客户端按 Markdown 渲染即可，无需识别本帧 |
| 收尾 | `{"done":true}` | 正常结束。将来可能附带元信息键，客户端忽略未知键即可 |

语义保证：

- `done` 只在上游完整走完后发出，收到 `done` 表示本次已计额度。
- 未收到 `done` 即连接结束或出错，视为断流：服务端不计额度，客户端按可重试处理。
- 错误不进流：能预判的错误（校验、鉴权、额度）在流开始前以普通 JSON 错误返回；流开始后的上游故障只表现为断流。
- 客户端主动断开后，服务端可能继续读完上游并计额度（结果落缓存供后续命中），客户端不应假设断开即退款。

### 一次性响应（`stream` 缺省）

`200`，`{"content":"..."}`。不支持搜索事件与来源。

### 错误响应

非 2xx 一律 JSON：`{"success":false,"error":"<文案>","code":"<错误码>"}`；429 额外带 `tier` 与可选的 `resetAt`（ISO 时间，下次授予额度的时刻）。`error` 文案只用于日志与兜底展示，客户端按 `code` 选文案与处置。

| HTTP | `code` | 含义 | 客户端处置 |
|---|---|---|---|
| 400 | `missing_install_id` | 缺安装标识 | 编程错误 |
| 400 | `invalid_json` / `invalid_request` | 请求体不合法 | 编程错误 |
| 400 | `invalid_message_format` | 角色或 content 形状不合法 | 编程错误 |
| 400 | `content_too_long` | 单条用户消息超 4000 字符 | 提示用户缩短 |
| 400 | `last_must_be_user` | 末条不是用户消息 | 编程错误 |
| 400 | `images_in_history` | 历史轮带图 | 编程错误（历史轮应降级为占位文本） |
| 400 | `too_many_images` / `image_too_large` / `images_too_large` | 图片数量或体积超限 | 提示用户 |
| 400 | `images_unsupported` **[v2 新增]** | 所选模型不接受图片 | 提示换模型或去图；正常客户端应已按 `caps` 隐藏入口 |
| 400 | `search_unsupported` **[v2 新增]** | 所选模型不支持搜索 | 同上 |
| 403 | `search_requires_pro` | 非 Pro 档开搜索 | 展示 Pro 门槛说明；正常客户端应在开启前已拦 |
| 400 | `image_generation_unsupported` **[v3 新增]** | 所选模型不支持图片生成 | 同上 |
| 400 | `image_generation_requires_stream` **[v3 新增]** | 非流式请求开了生图 | 编程错误 |
| 401 | `auth_invalid` | 令牌无效或过期 | 刷新令牌后重试；仍失败按未登录处理 |
| 403 | `images_require_login` | 匿名档发图 | 引导登录 |
| 403 | `image_generation_requires_pro` **[v3 新增]** | 非 Pro 档开生图 | 展示 Pro 门槛说明；正常客户端应在开启前已拦 |
| 429 | `quota_device` | 个人日额度用尽 | 展示触顶卡片；匿名档引导登录，登录档引导升级 |
| 429 | `quota_global` | 当日全局预算用尽 | 展示「今日繁忙」，不引导付费 |
| 502 | `upstream_error` | 上游模型故障 | 可重试 |
| 502 | `upstream_timeout` | 上游超时 | 可重试 |
| 502 | `upstream_region_blocked` | 上游按访客地区拒绝 | **不可重试**，隐藏重试按钮，展示地区不可用文案 |

429 的 `tier` 有一个额外用途：客户端自认已登录却收到 `tier: anonymous`，说明令牌缺失或被拒后静默降级，应提示重新登录而不是重试。

## `POST /api/chat/transcribe`

multipart 字段：

| 字段 | 必传 | 说明 |
|---|---|---|
| `file` | 是 | 音频，`audio/mp4`，非空；体积上限 2 MB |
| `duration_ms` | 是 | 正整数毫秒；上限由 `/api/app-config` 的 `chat_voice.max_duration_ms` 下发，默认 60000 |
| `lang` | 否 | `zh` 或其它，作为语言提示的主语言 |

响应 `200`：`{"text":"...","languages":["zh-cn"]}`。转写文本由客户端再经 `/api/chat` 正常发送，服务端不把音频入库。

错误码在 chat 之外增加：400 `audio_empty` / `audio_too_large` / `audio_too_long`，403 `voice_requires_pro`（非 Pro 档），429 与 502 同 chat。

## 兼容策略

- **不算破坏**：响应新增字段或新增帧类型；错误码新增；目录内容变化。客户端对未知字段与未知帧必须忽略，数据类字段必须带缺省。
- **算破坏**：删除或改名字段、改变既有字段语义、改变帧顺序保证、改变错误码含义。破坏性变更须升本文主版本号并在客户端仓开跟进 issue，客户端版本落地前不关。
- 服务端先于客户端上线是常态；新字段对旧客户端无害是设计前提。
