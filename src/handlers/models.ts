import type { ChatContext } from "../config.js";
import { methodGuard, jsonOk } from "../http.js";
import { fetchChatModels, DEFAULT_MODEL } from "../models.js";

/**
 * GET /chat/models —— 供客户端渲染模型选择器。
 * `default` = 未手选时服务端实际使用的模型，显式写进契约供客户端展示与留痕。
 * 仅供展示：实际强制在 /chat 的 resolveModel，按 tier 逐请求裁决。
 * 公开只读：仅目录 + tier 标签，用户是否 Pro 由宿主自己的端点给。
 */
export async function handleChatModels(request: Request, ctx: ChatContext): Promise<Response> {
  const blocked = methodGuard(request, ["GET"]);
  if (blocked) return blocked;

  const models = await fetchChatModels(ctx);
  return jsonOk({ default: DEFAULT_MODEL, models }, 300);
}
