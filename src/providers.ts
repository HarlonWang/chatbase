// 厂商注册表：chat 路径里「按厂商不同」的全部知识只允许写在这里（数据）与 chat/policy 的能力裁决（一处）。
// 各家都原生说 Responses API，公共层 llm.ts 不做协议翻译。
//
// 一家厂商 = 一个条目，分四段：
//   transport  baseUrl / relay / requestDefaults —— 怎么打上游（凭据由宿主 ChatConfig.providers 给）
//   catalog    owns / admit / displayName / sort / free / defaultTier —— 模型的存在性从厂商 /models 拉，
//              这里只写「哪些可提供、怎么展示、默认什么档」的策略；不写模型列表
//   aliases    厂商改名后的旧 id → 新 id，请求进来先换名再准入、计价、记账
//   prices     牌价（微美元 / 1M tokens），厂商 API 不给价，只能人工登记；overrides 是按 id 的能力 / 档位例外
// requestDefaults 是唯一允许的「按厂商改请求体」入口，由 callChat 最后展开进请求体：只追加字段，
// 例外是 store——callChat 固定发 true，不想让厂商留存对话的在这里覆盖成 false。

import type { ProviderId, Tier } from "./config.js";

export interface ModelCaps {
  images: boolean;
  search: boolean;
  imageGeneration: boolean;
}

export interface ModelPrice {
  inPerM: number;
  outPerM: number;
  cachedInPerM?: number;
}

export interface Provider {
  id: ProviderId;
  name: string;
  baseUrl: string;
  /** 403 时回落到非 CF 中转（仅托管在 CF 网内的厂商需要） */
  relay: boolean;
  defaultCaps: ModelCaps;
  searchCallMicros: number;
  imageGenerationTool: Record<string, unknown> | null;
  imageGenerationCallMicros: number;
  requestDefaults: Record<string, unknown>;
  catalog: {
    owns: (id: string) => boolean;
    admit: (id: string) => boolean;
    displayName: (id: string) => string;
    sort: (a: string, b: string) => number;
    /** 内置免费白名单：宿主未给 ChatConfig.models.free 时的缺省（安全下限，唯一硬编码） */
    free: string[];
    defaultTier: Tier;
  };
  aliases: Record<string, string>;
  overrides: Record<string, { caps?: Partial<ModelCaps>; minTier?: Tier }>;
  prices: Record<string, ModelPrice>;
}

// gpt-<major>[.<minor>][-<suffix>]；suffix 任意但不能是日期快照（与别名同一模型，进目录会重名）
const GPT_SHAPE = /^gpt-(\d+)(?:\.(\d+))?(?:-(.+))?$/;
const DATE_SNAPSHOT = /-\d{4}-\d{2}-\d{2}$/;
// 可提供的最低版本 (major, minor)，退役旧一代时手动上调；不从 free 推导——免费档升降是独立决策。
// 5.6 之前是变体制（裸名 + mini/nano/pro/codex/chat-latest/search-api），阈值同时挡住那批 id
const GPT_MIN_OFFERED: [number, number] = [5, 6];

/** 解析 OpenAI 形状：{ major, minor, suffix }（gpt-6-astra → 6/0/'astra'）；形状不符或日期快照 → null */
export function parseGptModel(id: unknown): { major: number; minor: number; suffix: string | null } | null {
  if (typeof id !== "string" || DATE_SNAPSHOT.test(id)) return null;
  const m = GPT_SHAPE.exec(id);
  if (!m) return null;
  return { major: Number(m[1]), minor: m[2] != null ? Number(m[2]) : 0, suffix: m[3] || null };
}

const capitalize = (w: string) => w[0].toUpperCase() + w.slice(1);

export const PROVIDERS: Record<ProviderId, Provider> = {
  openai: {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    relay: true,
    defaultCaps: { images: true, search: true, imageGeneration: true },
    searchCallMicros: 10_000, // $10 / 1k calls，token 之外的按次费
    // 生图是挂在主线模型上的 hosted 工具，不是可选模型。质量固定 low：成图已达可用，
    // 且 high 档官方可到 2 min，会撞中转 Lambda 的 60 s 超时
    imageGenerationTool: {
      type: "image_generation", model: "gpt-image-2.5-flare",
      quality: "low", size: "auto", output_format: "jpeg", partial_images: 0,
    },
    // 图片 token 不进 response.usage，只能按张记：low 档输出约 $0.006 + 输入参考图估 $0.01，取整保守
    imageGenerationCallMicros: 20_000,
    requestDefaults: {},
    catalog: {
      owns: (id) => typeof id === "string" && id.startsWith("gpt-"),
      // 准入只看版本不看后缀：5.6 起改为分档命名（sol/terra/luna/astra），新型号/新分档/新一代无需登记即上架；
      // 成本由牌价兜底，不靠名字挡
      admit(id) {
        const p = parseGptModel(id);
        if (p == null) return false;
        const [major, minor] = GPT_MIN_OFFERED;
        return p.major > major || (p.major === major && p.minor >= minor);
      },
      /** gpt-5.6 → GPT-5.6；gpt-6-astra → GPT-6 Astra；gpt-6-chat-latest → GPT-6 Chat Latest */
      displayName(id) {
        const { suffix } = parseGptModel(id)!;
        const base = (suffix ? id.slice(0, -(suffix.length + 1)) : id).replace(/^gpt/i, "GPT");
        return suffix ? `${base} ${suffix.split("-").map(capitalize).join(" ")}` : base;
      },
      // 版本升序（免费默认所在的旧一代排前），同版本内裸别名在前、其余按 id 字母序
      sort(a, b) {
        const pa = parseGptModel(a)!, pb = parseGptModel(b)!;
        return pa.major - pb.major || pa.minor - pb.minor
          || (pa.suffix ? 1 : 0) - (pb.suffix ? 1 : 0)
          || a.localeCompare(b);
      },
      free: ["gpt-5.6-luna"],
      defaultTier: "pro",
    },
    aliases: {},
    overrides: {},
    // 取 developers.openai.com/api/docs/pricing 短上下文标准档
    prices: {
      "gpt-6-astra":   { inPerM: 10_000_000, outPerM: 50_000_000 },
      "gpt-6-sol":     { inPerM: 2_000_000,  outPerM: 10_000_000 },
      "gpt-6-luna":    { inPerM: 100_000,    outPerM: 500_000 },
      // sol 现价是促销价，官方承诺至少延续到 2026-11-21，之后可能回涨——届时不改这里会静默低估
      "gpt-5.6-sol":   { inPerM: 4_000_000, outPerM: 20_000_000 },
      "gpt-5.6-terra": { inPerM: 2_000_000, outPerM: 12_000_000 },
      "gpt-5.6-luna":  { inPerM: 200_000,   outPerM: 1_200_000 },
      "gpt-5.5":       { inPerM: 5_000_000, outPerM: 30_000_000 },
      "gpt-5.4":       { inPerM: 2_500_000, outPerM: 15_000_000 },
    },
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    relay: false, // 托管在 AWS CloudFront，不在 CF 网内，不受访客地理透传影响
    // search 关：流式下 output_item.added 把旁白也标成 final_answer，真 phase 只在 done 才出现，无法在转发前过滤（2026-09-08 实测）
    defaultCaps: { images: false, search: false, imageGeneration: false },
    searchCallMicros: 0,
    imageGenerationTool: null,
    imageGenerationCallMicros: 0,
    // 默认关思考：思考 token 计入 output_tokens，会挤爆 max_output_tokens 截断正文
    requestDefaults: { reasoning: { effort: "none" } },
    catalog: {
      owns: (id) => typeof id === "string" && id.startsWith("deepseek-"),
      // 排除 V4 之前的旧名（chat / reasoner）与 -exp 实验型；其余 deepseek-* 均可提供
      admit: (id) => /^deepseek-[a-z0-9.-]+$/.test(id) && !/^deepseek-(chat|reasoner)$/.test(id) && !/-exp$/.test(id),
      /** deepseek-flash → DeepSeek Flash；deepseek-v4-pro → DeepSeek V4 Pro */
      displayName: (id) => `DeepSeek ${id.slice("deepseek-".length).split("-").map(capitalize).join(" ")}`,
      sort: (a, b) => a.localeCompare(b),
      free: [],
      defaultTier: "pro",
    },
    // 2026-09-10 V4.1 Flash 上线后 v4-flash 退役，旧名暂被厂商路由到新模型，何时停用未公告
    aliases: { "deepseek-v4-flash": "deepseek-flash", "deepseek-v4-flash-vision-exp": "deepseek-flash" },
    // V4 Pro 不识图却对 input_image 返回 200 并编造内容（2026-09-22 实测），images 必须留 false 靠 400 挡
    overrides: { "deepseek-flash": { caps: { images: true } } },
    // 取 api-docs.deepseek.com/quick_start/pricing 的峰值价（非高峰减半，按贵的记）
    prices: {
      "deepseek-flash":  { inPerM: 300_000,   cachedInPerM: 6_000,  outPerM: 1_200_000 },
      "deepseek-v4-pro": { inPerM: 1_320_000, cachedInPerM: 44_000, outPerM: 3_960_000 },
    },
  },
  zhipu: {
    id: "zhipu",
    name: "Zhipu AI",
    // Responses 基址；对话补全是另一套 /api/paas/v4，不混用
    baseUrl: "https://open.bigmodel.cn/api/v1",
    relay: false,
    // 5.3 是纯文本模型，对 input_image 返回 200 并礼貌说「无法查看图片」（2026-09-22 实测），images 靠 400 挡
    defaultCaps: { images: false, search: true, imageGeneration: false },
    searchCallMicros: 1_500, // Search-Std ¥0.01 / 次；Responses 内 web_search 用哪一档官方未写，按 Std 记
    imageGenerationTool: null,
    imageGenerationCallMicros: 0,
    // effort 必须 low：GLM-5.3 强制思考（none → 400）且思维链计入 max_output_tokens，默认 max 会把预算全烧在思考上。
    // store 覆盖成 false：智谱默认不存，没有理由让它留 7 天
    requestDefaults: { reasoning: { effort: "low" }, store: false },
    catalog: {
      owns: (id) => typeof id === "string" && id.startsWith("glm-"),
      // 只放 glm-5.<minor>[-flash]，minor ≥ 3；挡掉 glm-5-turbo / 4.x 旧代与 -flashx 之类变体
      admit(id) {
        const m = /^glm-5\.(\d+)(-flash)?$/.exec(id);
        return m != null && Number(m[1]) >= 3;
      },
      /** glm-5.3 → GLM-5.3；glm-5.3-flash → GLM-5.3 Flash */
      displayName: (id) => `GLM-${id.slice("glm-".length).split("-").map(capitalize).join(" ")}`,
      sort: (a, b) => a.localeCompare(b),
      free: [],
      defaultTier: "pro",
    },
    aliases: {},
    overrides: { "glm-5.3-flash": { caps: { images: true } } }, // 原生多模态，实测看图正确
    // 取 bigmodel.cn/pricing 标准价（Flash 的限时五折不记），人民币按 7.0 换算成微美元，略高估
    prices: {
      "glm-5.3":       { inPerM: 1_143_000, cachedInPerM: 286_000, outPerM: 4_000_000 },
      "glm-5.3-flash": { inPerM: 114_000,   cachedInPerM: 33_000,  outPerM: 400_000 },
    },
  },
};

export const PROVIDER_LIST: Provider[] = Object.values(PROVIDERS);

/** 别名 → 正式 id；非别名原样返回。请求、计价、记账都以正式 id 为准 */
export function canonicalModel(modelId: string): string {
  for (const p of PROVIDER_LIST) {
    if (Object.hasOwn(p.aliases, modelId)) return p.aliases[modelId];
  }
  return modelId;
}

/** 声明拥有该 id 的厂商；无人认领 → undefined */
export function providerOwning(modelId: string): Provider | undefined {
  return PROVIDER_LIST.find((p) => p.catalog.owns(modelId));
}

/** 模型所属厂商。无人认领的 id 视为 OpenAI：准入（models.ts）已保证到达这里的都是可提供模型 */
export function providerOf(modelId: string): Provider {
  return providerOwning(modelId) ?? PROVIDERS.openai;
}

// 以下按 id 的查询都先把别名换成正式 id：绕过 resolveModel 的调用方拿到的能力 / 档位 / 牌价与正式 id 一致

/** 模型能力：按 id 的覆盖优先于厂商默认 */
export function capsOf(modelId: string): ModelCaps {
  const model = canonicalModel(modelId);
  const p = providerOf(model);
  return { ...p.defaultCaps, ...(p.overrides[model]?.caps ?? {}) };
}

/** 模型档位：按 id 覆盖 > 免费白名单 > 厂商默认。freeModels 是宿主解析后的白名单（ChatContext.freeModels），不给用厂商内置 */
export function minTierOf(modelId: string, freeModels?: string[]): Tier {
  const model = canonicalModel(modelId);
  const p = providerOf(model);
  const free = freeModels ?? p.catalog.free;
  return p.overrides[model]?.minTier ?? (free.includes(model) ? "user" : p.catalog.defaultTier);
}

/** 登记的牌价；未登记 → undefined（由 credits.ts 按保守 default 计） */
export function priceOf(modelId: string): ModelPrice | undefined {
  const model = canonicalModel(modelId);
  return providerOwning(model)?.prices[model];
}

/** 该模型是否有登记牌价（无则按保守 default 计成本） */
export function hasModelPrice(modelId: string): boolean {
  return priceOf(modelId) != null;
}
