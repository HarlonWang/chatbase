import type { Tier } from "./config.js";

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Install-Id",
};

export function handlePreflight(): Response {
  return new Response(null, { headers: CORS_HEADERS });
}

/** 可缓存 JSON：cacheSeconds 为 0 即 no-store（不是 max-age=0） */
export function jsonOk(data: unknown, cacheSeconds = 0, swrSeconds = 0): Response {
  let cacheControl = "no-store";
  if (cacheSeconds > 0) {
    cacheControl = `public, max-age=${cacheSeconds}`;
    if (swrSeconds > 0) cacheControl += `, stale-while-revalidate=${swrSeconds}`;
  }
  return Response.json(data, { headers: { ...CORS_HEADERS, "Cache-Control": cacheControl } });
}

/** 不可缓存 JSON（个人数据、写操作应答） */
export function jsonNoStore(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return Response.json(data, {
    status,
    headers: { ...CORS_HEADERS, "Cache-Control": "private, no-store", ...extraHeaders },
  });
}

/** extra 附加到 body（如 tier，客户端据此选卡片形态） */
export function jsonError(message: string, status = 500, code?: string, extra: Record<string, unknown> = {}): Response {
  const body: Record<string, unknown> = { success: false, error: message };
  if (code) body.code = code;
  return Response.json({ ...body, ...extra }, { status, headers: CORS_HEADERS });
}

/** OPTIONS 预检与方法白名单：返回 Response 即应直接回给客户端，null 表示放行 */
export function methodGuard(request: Request, allowed: string[]): Response | null {
  if (request.method === "OPTIONS") return handlePreflight();
  if (!allowed.includes(request.method)) return jsonError("Method not allowed", 405, "method_not_allowed");
  return null;
}

export async function readJsonBody(request: Request): Promise<{ body: any; errorResponse?: undefined } | { body?: undefined; errorResponse: Response }> {
  try {
    return { body: await request.json() };
  } catch {
    return { errorResponse: jsonError("Invalid JSON", 400, "invalid_json") };
  }
}

export function requireInstallId(request: Request): { installId: string; errorResponse?: undefined } | { installId?: undefined; errorResponse: Response } {
  const installId = (request.headers.get("X-Install-Id") || "").trim();
  if (!installId) return { errorResponse: jsonError("Missing install id", 400, "missing_install_id") };
  return { installId };
}

const QUOTA_MESSAGES: Record<string, string> = {
  quota_device: "Daily limit reached",
  quota_global: "Service is busy today, please try again tomorrow",
};

/** 429：比 jsonError 多带 tier（客户端据此选触顶卡片形态）与 resetAt（次日 UTC 零点） */
export function quotaExceeded(code: string, tier: Tier, resetAt?: string): Response {
  return jsonError(QUOTA_MESSAGES[code] ?? "Quota exceeded", 429, code, { tier, ...(resetAt ? { resetAt } : {}) });
}

export function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}
