import { Hono } from "hono";
import type { ChatContext } from "./config.js";
import { handleChat } from "./handlers/chat.js";
import { handleChatModels } from "./handlers/models.js";
import { handleChatTranscribe } from "./handlers/transcribe.js";
import { handleQuota } from "./handlers/quota.js";
import { handleGeneratedImage } from "./handlers/generated-image.js";
import { jsonError } from "./http.js";

/**
 * 端点子应用。handler 是 Request → Response 的裸函数（OPTIONS 预检与方法白名单在 handler 内），
 * Hono 只做路径分发，宿主用 Hono 或裸 Worker 都能挂。
 */
export function createChatApp<TEnv extends object>(getContext: (env: TEnv) => ChatContext, basePath: string): Hono<{ Bindings: TEnv }> {
  const app = new Hono<{ Bindings: TEnv }>().basePath(basePath);
  const ctxOf = (c: { env: TEnv }) => getContext(c.env);

  app.all("/chat", (c) => handleChat(c.req.raw, ctxOf(c), c.executionCtx));
  app.all("/chat/models", (c) => handleChatModels(c.req.raw, ctxOf(c)));
  app.all("/chat/transcribe", (c) => handleChatTranscribe(c.req.raw, ctxOf(c), c.executionCtx));
  app.all("/chat/generated-images/:key", (c) => handleGeneratedImage(c.req.raw, ctxOf(c), c.req.param("key")));
  app.all("/quota", (c) => handleQuota(c.req.raw, ctxOf(c)));
  app.notFound(() => jsonError("Not found", 404, "not_found"));
  return app;
}
