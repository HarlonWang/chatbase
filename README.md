# chatbase

> Multi-provider AI chat for Cloudflare Workers: streaming, a credits ledger and a model catalog, mounted into the Worker you already run.

[![npm](https://img.shields.io/npm/v/@whlong/chatbase)](https://www.npmjs.com/package/@whlong/chatbase)
[![license](https://img.shields.io/npm/l/@whlong/chatbase)](LICENSE)

chatbase is a library, not a service. It mounts into your Worker as a Hono sub-app, talks to OpenAI, DeepSeek and Zhipu through the Responses API, streams replies to your client as SSE, and keeps a credits ledger in **your** D1. It does not know who your users are or what they pay for: your Worker answers one question per request, "which tier is this?", and chatbase does the rest.

The client half is [chatbase-kmp](https://github.com/HarlonWang/chatbase-kmp), a Kotlin Multiplatform + Compose Multiplatform SDK. The wire protocol between the two lives in [docs/chat-protocol.md](docs/chat-protocol.md).

## What you get

- **Four endpoints, one mount.** `POST /api/chat` (SSE or JSON), `GET /api/chat/models`, `POST /api/chat/transcribe`, `GET /api/quota`, plus generated-image serving.
- **Multi-provider with one request shape.** Provider quirks live in one registry file; the catalog is pulled from each provider's `/models` and filtered by admission rules, so new models show up without a deploy.
- **A ledger, not a counter.** Daily grants per tier, atomic pre-charge, settlement with true cost in micro-dollars, refunds on failure, a global dollar circuit breaker, and a cron that reclaims orphaned charges. `balance` is a cache; the truth is always Σgrants − Σevents.
- **Hosted tools.** Web search and image generation ride on the main model as tools, priced per call, gated by tier.
- **Nothing about users.** Identity comes from your `resolveTier`; Pro is whatever you say it is.

## Quick start

```bash
npm install @whlong/chatbase
```

Apply the migrations (`identities`, `credit_grants`, `usage_events`, `chat_logs`):

```toml
[[d1_databases]]
binding = "DB"
migrations_dir = "node_modules/@whlong/chatbase/migrations"
```

Create and mount:

```ts
import { createChat } from "@whlong/chatbase";

export const chat = createChat<Env>((env) => ({
  db: env.DB,
  kv: env.APP_CONFIG,              // optional: runtime image/voice limits
  images: env.GENERATED_IMAGES,    // optional: R2 for generated images
  providers: {
    openai: { apiKey: env.OPENAI_API_KEY },
    deepseek: { apiKey: env.DEEPSEEK_API_KEY },
  },
  resolveTier: async (request) => {
    const token = bearerOf(request);
    if (!token) return { tier: "anonymous" };
    const sub = await verify(token).catch(() => null);
    if (!sub) return { authInvalid: true };
    return { tier: (await isPro(sub)) ? "pro" : "user", userSub: sub };
  },
  prompt: { brand: "Tono" },
}));

export default {
  fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/api/chat") || pathname === "/api/quota") return chat.fetch(request, env, ctx);
    return new Response("Not found", { status: 404 });
  },
  scheduled(_event, env, ctx) {
    ctx.waitUntil(chat.reclaim(env));   // every 10 minutes
  },
};
```

Hono hosts use `app.route("/", chat.app)` instead of `chat.fetch`.

## Configuration

| Field | Required | Notes |
|---|---|---|
| `db` | yes | D1 holding the four tables |
| `kv` | no | Reads `chat_images` and `chat_voice` keys for runtime limits |
| `images` | no | R2 bucket; without it image generation is refused |
| `providers` | yes | Enabled providers and keys; `openai.relay` adds a fallback for region-blocked requests |
| `resolveTier` | yes | `(request) => { tier: "anonymous" } \| { tier: "user" \| "pro", userSub } \| { authInvalid: true }` |
| `prompt.brand` | yes | Product name in the system prompt |
| `prompt.system` | no | Replace the whole system prompt |
| `prompt.context` | no | Render the request's `context` into the system prompt; ignored when absent |
| `credits` | no | `dailyGrant`, `rateCard`, `globalBudgetMicros`; defaults exported as `DEFAULT_CREDITS` |
| `logging` | no | Write user questions to `chat_logs` (default `true`) |
| `onBlocked` | no | Called when a request is refused by quota, for analytics |

`createChat(resolve, { basePath })` changes the mount point (default `/api`).

## Lower-level exports

`callChat` and `transcribeAudio` call providers directly, for background jobs that should not touch the ledger. `getChatImagesConfig`, `getChatVoiceConfig` and `DEFAULT_CREDITS` let your own config endpoint tell clients the same numbers the server enforces.

## Development

```bash
npm run typecheck && npm run build && npm test
```

Tests run in two projects: `unit` with a mocked D1 and `d1` inside workerd against a real D1, which is the only place ledger invariants that depend on D1 semantics are checked.

## License

MIT
