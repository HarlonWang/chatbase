// 生成图落 R2，经 /api/chat/generated-images/:key 回吐；key 是随机 uuid，
// 不可猜即访问控制，不另做鉴权——图片 URL 要能被客户端 Markdown 渲染器（无鉴权头）直接加载。

import type { ChatContext } from "./config.js";

const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/;

/** 回吐路径前缀，跟随宿主挂载点 */
export function generatedImagePath(basePath = "/api"): string {
  return `${basePath}/chat/generated-images/`;
}

export const GENERATED_IMAGE_PATH = generatedImagePath();

export function isGeneratedImageKey(key: string): boolean {
  return KEY_RE.test(key);
}

/** base64 JPEG → R2；返回可公开访问的绝对 URL（以请求 origin 为基）。ctx.images 未配置时抛错 */
export async function storeGeneratedImage(ctx: ChatContext, origin: string, base64: string): Promise<string> {
  if (!ctx.images) throw new Error("generated images bucket not configured");
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const key = `${crypto.randomUUID()}.jpg`;
  await ctx.images.put(key, bytes, { httpMetadata: { contentType: "image/jpeg" } });
  return `${origin}${generatedImagePath(ctx.basePath)}${key}`;
}

/** 从我们自己签发的图片 URL 里取 key；不是本服务的图片 URL 返回 null */
export function generatedImageKeyFromUrl(url: unknown, origin: string, basePath = "/api"): string | null {
  const prefix = `${origin}${generatedImagePath(basePath)}`;
  if (typeof url !== "string" || !url.startsWith(prefix)) return null;
  const key = url.slice(prefix.length);
  return isGeneratedImageKey(key) ? key : null;
}
