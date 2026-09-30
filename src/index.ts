import type { Hono } from "hono";
import { memoizeResolver, type ChatConfig, type ChatContext, type CreateChatOptions } from "./config.js";
import { createChatApp } from "./app.js";
import { reclaimOrphanedPending } from "./credits.js";

export interface Chat<TEnv extends object> {
  /** Hono 实例（已含 basePath）。Hono 消费方：app.route("/", chat.app) */
  app: Hono<{ Bindings: TEnv }>;
  /** 裸 Worker 挂载：if (pathname.startsWith("/api/chat") || pathname === "/api/quota") return chat.fetch(req, env, ctx) */
  fetch: (request: Request, env: TEnv, ctx?: ExecutionContext) => Response | Promise<Response>;
  /** cron：回收孤儿 pending 账单行，建议每 10 分钟 */
  reclaim: (env: TEnv) => Promise<{ scanned: number; reclaimed: number; refunded: number }>;
  /** 解析后的上下文，供宿主复用底层出口（如 callChat）时传入 */
  context: (env: TEnv) => ChatContext;
}

export function createChat<TEnv extends object = any>(
  resolve: (env: TEnv) => ChatConfig,
  options: CreateChatOptions = {},
): Chat<TEnv> {
  const basePath = options.basePath ?? "/api";
  const getContext = memoizeResolver(resolve, basePath);
  const app = createChatApp(getContext, basePath);
  return {
    app,
    fetch: (request, env, ctx) => app.fetch(request, env, ctx),
    reclaim: (env) => reclaimOrphanedPending(getContext(env)),
    context: getContext,
  };
}

export type {
  ChatConfig,
  ChatContext,
  ChatContextInput,
  CreateChatOptions,
  CreditsConfig,
  PromptConfig,
  ProviderContext,
  ProviderCredentials,
  ProviderId,
  BlockedEvent,
  Tier,
  TierInfo,
  TierResolver,
} from "./config.js";
export { DEFAULT_CREDITS, resolveContext } from "./config.js";

// 底层出口：宿主的后台任务（爬虫等）直接调模型；app-config 类端点拼配置
export { callChat, transcribeAudio } from "./llm.js";
export { PROVIDERS, canonicalModel, capsOf, minTierOf, priceOf, hasModelPrice, providerOf } from "./providers.js";
export type { Provider, ModelCaps, ModelPrice } from "./providers.js";
export { resolveModel, isOfferedModel, fetchChatModels, DEFAULT_MODEL, FREE_MODELS } from "./models.js";
export { computeTrueCostMicros, nextGrantAtUTC, PENDING_TIMEOUT_MS } from "./credits.js";
export { getChatImagesConfig, CHAT_IMAGES_DEFAULTS } from "./chat-images.js";
export { getChatVoiceConfig, CHAT_VOICE_DEFAULTS, TRANSCRIBE_MODEL } from "./chat-voice.js";
export { renderItemContext } from "./chat/input.js";
export type { Usage } from "./usage.js";
