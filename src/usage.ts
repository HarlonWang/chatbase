// 上游 usage 的归一化形状：计费层读 prompt/completion_tokens，按次费的 search_calls / image_generation_calls 只在有值时附带。

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  /** 缓存命中的 input tokens；缓存价与全价差 10～30 倍，计费按此折算 */
  cached_tokens?: number;
  search_calls?: number;
  image_generation_calls?: number;
}

/** Responses API 的 input_tokens/output_tokens 与 Chat Completions 命名都归一到 Usage */
export function normalizeUsage(usage: any): Usage | null {
  if (!usage) return null;
  const out: Usage = {
    prompt_tokens: usage.input_tokens ?? usage.prompt_tokens ?? 0,
    completion_tokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
  };
  const cached = usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
  if (cached > 0) out.cached_tokens = cached;
  return out;
}

/** web_search 按次费不在 usage 里，只能数 output 的 web_search_call 项 */
export function countWebSearchCalls(output: any[] | undefined | null): number {
  return (output ?? []).filter((o) => o?.type === "web_search_call").length;
}

export function withSearchCalls(usage: Usage | null, searchCalls: number): Usage | null {
  if (!searchCalls) return usage;
  return { ...(usage ?? { prompt_tokens: 0, completion_tokens: 0 }), search_calls: searchCalls };
}

export function withImageGenerationCalls(usage: Usage | null, imageGenerationCalls: number): Usage | null {
  if (!imageGenerationCalls) return usage;
  return { ...(usage ?? { prompt_tokens: 0, completion_tokens: 0 }), image_generation_calls: imageGenerationCalls };
}
