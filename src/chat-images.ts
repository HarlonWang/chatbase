// 图片参数单源：KV 的 chat_images（JSON，如 {"max_count":9,"per_image_jpeg_kb":280}）。
// 校验闸与客户端预检下发都从这里读——改 KV 即时生效、无需部署；未配置/解析失败一律回落默认。
// 配置合理性由运维负责：max_count × 预算须留在中转的请求体上限内，预算 ×4/3 不得超过单张 base64 闸。

export const CHAT_IMAGES_DEFAULTS = { maxCount: 9, perImageJpegKb: 280 };

export interface ChatImagesConfig {
  maxCount: number;
  perImageJpegKb: number;
  maxTotalImageB64: number;
}

// data-url 长度 = base64(ceil(bytes/3)×4) + "data:image/jpeg;base64," 前缀 23 字符
function dataUrlLen(jpegBytes: number): number {
  return Math.ceil(jpegBytes / 3) * 4 + 23;
}

function positiveInt(v: unknown, fallback: number): number {
  return Number.isInteger(v) && (v as number) > 0 ? (v as number) : fallback;
}

export async function getChatImagesConfig(kv: KVNamespace | null): Promise<ChatImagesConfig> {
  let cfg: any = null;
  try {
    const raw = await kv?.get("chat_images");
    if (raw) cfg = JSON.parse(raw);
  } catch {
    /* 格式配错按未配置处理 */
  }
  const maxCount = positiveInt(cfg?.max_count, CHAT_IMAGES_DEFAULTS.maxCount);
  const perImageJpegKb = positiveInt(cfg?.per_image_jpeg_kb, CHAT_IMAGES_DEFAULTS.perImageJpegKb);
  return {
    maxCount,
    perImageJpegKb,
    maxTotalImageB64: maxCount * dataUrlLen(perImageJpegKb * 1024),
  };
}
