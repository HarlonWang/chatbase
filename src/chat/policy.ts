// /api/chat 策略裁决（纯函数）：档位 × 模型 × 能力 × 开关 的全部组合规则集中在这里，
// 每条规则一行；新增 chip 在此加规则，不碰 handler 主流程。
// 不静默降级——用户付了额度，图片被上游换成占位符等于白扣。客户端按目录 caps 隐藏入口，这里只兜旧客户端。

import type { Tier } from "../config.js";
import { resolveModel, type ModelScope } from "../models.js";
import { capsOf, providerOf, type Provider } from "../providers.js";
import type { ChatRequest } from "./request.js";

export const MAX_TOKENS = 8192; // 回复 token 上限；截断不透传给客户端，压低前先看 usage_events 的 tokens_out 顶格率
const MAX_SEARCH_CALLS = 3; // 单条消息搜索调用上限（成本封顶，官方 max_tool_calls）

export interface PolicyError {
  error: { message: string; status: number; code: string };
}

export interface ChatPolicy {
  error?: undefined;
  model: string;
  provider: Provider;
  feature: string;
  /** 生图的按张费不在 token 里，预估进全局熔断 */
  extraCostMicros: number;
  upstream: {
    model: string;
    maxTokens: number;
    stream: boolean;
    retry: number;
    tools?: unknown[];
    maxToolCalls?: number;
  };
}

const deny = (message: string, status: number, code: string): PolicyError => ({ error: { message, status, code } });

/**
 * (请求, 档位, 生图是否可用) → 上游与计费参数 | { error }。
 * 规则顺序有意义：先档位后能力，让免费用户拿到的是「要 Pro」而不是「模型不支持」。
 */
export function decideChatPolicy(req: ChatRequest, tier: Tier, scope: ModelScope, { imagesEnabled = true }: { imagesEnabled?: boolean } = {}): ChatPolicy | PolicyError {
  // 图片理解仅登录档开放（客户端隐藏入口只是体验层，这里是真闸）
  if (req.imageCount > 0 && tier === "anonymous") return deny("Image input requires login", 403, "images_require_login");

  // 模型按 tier 强制（免费只能默认，Pro 可切任一「可提供」模型，见 models.ts）
  const model = resolveModel(scope, tier, req.requestedModel);
  const caps = capsOf(model);
  const provider = providerOf(model);

  if (req.imageCount > 0 && !caps.images) return deny("Model does not accept images", 400, "images_unsupported");
  if (req.wantSearch && tier !== "pro") return deny("Web search requires Pro", 403, "search_requires_pro");
  if (req.wantSearch && !caps.search) return deny("Model does not support search", 400, "search_unsupported");
  if (req.wantImageGeneration && tier !== "pro") return deny("Image generation requires Pro", 403, "image_generation_requires_pro");
  if (req.wantImageGeneration && (!caps.imageGeneration || !imagesEnabled)) return deny("Model does not support image generation", 400, "image_generation_unsupported");
  // 生图只走流式：JSON 路径没有存图/注入环节，图会被静默丢掉
  if (req.wantImageGeneration && !req.wantStream) return deny("Image generation requires stream mode", 400, "image_generation_requires_stream");

  const feature = req.wantImageGeneration ? "chat_image_generation" : req.wantSearch ? "chat_search" : "chat";
  // hosted 工具：搜索 medium 档；生图参数由厂商注册表给。max_tool_calls 封顶单条消息成本：
  // 生图 1 张封顶，搜索沿用搜索上限；两者互斥故不会同时挂
  const tools: unknown[] = req.wantImageGeneration ? [provider.imageGenerationTool]
    : req.wantSearch ? [{ type: "web_search", search_context_size: "medium" }]
    : [];

  return {
    model,
    provider,
    feature,
    extraCostMicros: req.wantImageGeneration ? provider.imageGenerationCallMicros : 0,
    upstream: {
      model,
      maxTokens: MAX_TOKENS,
      stream: req.wantStream,
      retry: 1, // 429/5xx/网络重试一次
      ...(tools.length ? { tools, maxToolCalls: req.wantImageGeneration ? 1 : MAX_SEARCH_CALLS } : {}),
    },
  };
}
