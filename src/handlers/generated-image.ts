import type { ChatContext } from "../config.js";
import { CORS_HEADERS, methodGuard, jsonError } from "../http.js";
import { isGeneratedImageKey } from "../generated-images.js";

/** GET /chat/generated-images/:key：回吐一张生成图。key 不可猜即访问控制；内容不可变，长缓存 */
export async function handleGeneratedImage(request: Request, ctx: ChatContext, key: string): Promise<Response> {
  const blocked = methodGuard(request, ["GET"]);
  if (blocked) return blocked;
  if (!isGeneratedImageKey(key)) return jsonError("Not found", 404, "not_found");

  const obj = await ctx.images?.get(key);
  if (!obj) return jsonError("Not found", 404, "not_found");
  return new Response(obj.body, {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": obj.httpMetadata?.contentType ?? "image/jpeg",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
