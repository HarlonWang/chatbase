import { describe, it, expect } from "vitest";
import {
  PROVIDERS, providerOf, providerOwning, capsOf, minTierOf, priceOf, canonicalModel, parseGptModel,
} from "../src/providers.js";

describe("providers 注册表", () => {
  it("按 owns 认领厂商；无人认领的 id 一律视为 OpenAI", () => {
    expect(providerOf("deepseek-flash").id).toBe("deepseek");
    expect(providerOf("deepseek-v4-flash").id).toBe("deepseek");   // 旧名也归 DeepSeek
    expect(providerOf("gpt-5.6-luna").id).toBe("openai");
    expect(providerOf("gpt-6-astra").id).toBe("openai");           // 动态上架的新型号，零登记
    expect(providerOf(undefined as any).id).toBe("openai");
    expect(providerOwning("claude-4")).toBeUndefined();
    expect(providerOwning(undefined as any)).toBeUndefined();
  });

  it("别名：旧 id 换成正式 id，非别名原样返回", () => {
    expect(canonicalModel("deepseek-v4-flash")).toBe("deepseek-flash");
    expect(canonicalModel("deepseek-v4-flash-vision-exp")).toBe("deepseek-flash");
    expect(canonicalModel("deepseek-flash")).toBe("deepseek-flash");
    expect(canonicalModel("gpt-5.6-luna")).toBe("gpt-5.6-luna");
    expect(canonicalModel(undefined as any)).toBeUndefined();
  });

  it("caps：厂商默认 + 按 id 覆盖", () => {
    expect(capsOf("gpt-5.6-luna")).toEqual({ images: true, search: true, imageGeneration: true });
    expect(capsOf("deepseek-flash")).toEqual({ images: true, search: false, imageGeneration: false });   // V4.1 Flash 原生看图
    expect(capsOf("deepseek-v4-flash")).toEqual(capsOf("deepseek-flash"));   // 旧名经别名与正式 id 同能力
    expect(capsOf("deepseek-v4-pro")).toEqual({ images: false, search: false, imageGeneration: false });
  });

  it("档位：免费白名单 user，其余按厂商默认；DeepSeek 全部 Pro 专属", () => {
    expect(minTierOf("gpt-5.6-luna")).toBe("user");
    expect(minTierOf("gpt-5.6-sol")).toBe("pro");
    expect(minTierOf("deepseek-flash")).toBe("pro");
    expect(minTierOf("deepseek-v4-pro")).toBe("pro");
    expect(minTierOf("deepseek-v5-nova")).toBe("pro");   // 未登记的新型号沿用厂商默认
  });

  it("牌价：按正式 id 查，别名同价；未登记 → undefined", () => {
    expect(priceOf("deepseek-flash")).toEqual({ inPerM: 300_000, cachedInPerM: 6_000, outPerM: 1_200_000 });
    expect(priceOf("deepseek-v4-flash")).toBe(priceOf("deepseek-flash"));
    expect(priceOf("gpt-6-astra")).toBeDefined();
    expect(priceOf("gpt-9-unknown")).toBeUndefined();
    expect(priceOf("default")).toBeUndefined();
  });

  it("DeepSeek 准入：deepseek-* 放行，旧名 chat/reasoner 与 -exp 实验型拒绝", () => {
    const { admit } = PROVIDERS.deepseek.catalog;
    expect(admit("deepseek-flash")).toBe(true);
    expect(admit("deepseek-v4-pro")).toBe(true);
    expect(admit("deepseek-v5-pro")).toBe(true);
    expect(admit("deepseek-chat")).toBe(false);
    expect(admit("deepseek-reasoner")).toBe(false);
    expect(admit("deepseek-v4-flash-vision-exp")).toBe(false);
    expect(admit("deepseek-Flash")).toBe(false);
  });

  it("Zhipu：owns / caps / 档位 / 牌价 / 准入 / 展示名", () => {
    expect(providerOf("glm-5.3").id).toBe("zhipu");
    expect(capsOf("glm-5.3")).toEqual({ images: false, search: true, imageGeneration: false });        // 纯文本模型，对图片静默丢弃
    expect(capsOf("glm-5.3-flash")).toEqual({ images: true, search: true, imageGeneration: false });   // 原生多模态
    expect(minTierOf("glm-5.3")).toBe("pro");
    expect(minTierOf("glm-5.3-flash")).toBe("pro");
    expect(priceOf("glm-5.3")).toEqual({ inPerM: 1_143_000, cachedInPerM: 286_000, outPerM: 4_000_000 });
    expect(priceOf("glm-5.4")).toBeUndefined();
    expect(PROVIDERS.zhipu.requestDefaults).toEqual({ reasoning: { effort: "low" }, store: false });

    const { admit, displayName } = PROVIDERS.zhipu.catalog;
    expect(admit("glm-5.3")).toBe(true);
    expect(admit("glm-5.3-flash")).toBe(true);
    expect(admit("glm-5.10")).toBe(true);           // 未登记的新型号放行，靠牌价漂移日志提醒补价
    expect(admit("glm-5.2")).toBe(false);           // 5.3 之前的旧代
    expect(admit("glm-5-turbo")).toBe(false);
    expect(admit("glm-5.3-flashx")).toBe(false);
    expect(admit("glm-4.7")).toBe(false);
    expect(displayName("glm-5.3")).toBe("GLM-5.3");
    expect(displayName("glm-5.3-flash")).toBe("GLM-5.3 Flash");
  });

  it("展示名从 id 推导", () => {
    expect(PROVIDERS.deepseek.catalog.displayName("deepseek-flash")).toBe("DeepSeek Flash");
    expect(PROVIDERS.deepseek.catalog.displayName("deepseek-v4-pro")).toBe("DeepSeek V4 Pro");
    expect(PROVIDERS.openai.catalog.displayName("gpt-6-chat-latest")).toBe("GPT-6 Chat Latest");
    expect(parseGptModel("gpt-6-astra")).toEqual({ major: 6, minor: 0, suffix: "astra" });
    expect(parseGptModel("gpt-5.6-sol-2026-06-23")).toBeNull();
  });

  it("DeepSeek 不走中转、默认关思考、搜索无按次费", () => {
    expect(PROVIDERS.deepseek.relay).toBe(false);
    expect(PROVIDERS.deepseek.requestDefaults).toEqual({ reasoning: { effort: "none" } });
    expect(PROVIDERS.deepseek.searchCallMicros).toBe(0);
    expect(PROVIDERS.openai.searchCallMicros).toBe(10_000);
  });

  it("每家条目形状完整：id 与键一致、Responses API 前缀、目录策略四件套、别名目标可准入", () => {
    for (const [key, p] of Object.entries(PROVIDERS)) {
      expect(p.id).toBe(key);
      expect(p.baseUrl).toMatch(/\/v1$/);
      for (const k of ["owns", "admit", "displayName", "sort"] as const) expect(typeof p.catalog[k]).toBe("function");
      expect(Array.isArray(p.catalog.free)).toBe(true);
      for (const id of p.catalog.free) expect(p.catalog.owns(id) && p.catalog.admit(id)).toBe(true);
      for (const target of Object.values(p.aliases)) expect(p.catalog.owns(target) && p.catalog.admit(target)).toBe(true);
      for (const id of Object.keys(p.prices)) expect(p.catalog.owns(id)).toBe(true);
    }
  });
});
