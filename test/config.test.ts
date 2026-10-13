import { describe, it, expect } from "vitest";
import { resolveContext, type ChatConfig } from "../src/config.js";

const base: ChatConfig = {
  db: {} as D1Database,
  providers: { openai: { apiKey: "k" } },
  resolveTier: () => ({ tier: "anonymous" }),
  prompt: { brand: "T" },
};

describe("resolveContext：logging 与保留天数", () => {
  it("默认写日志、永久保留", () => {
    expect(resolveContext(base)).toMatchObject({ logging: true, logRetentionDays: null });
  });

  it("logging: false 不写日志", () => {
    expect(resolveContext({ ...base, logging: false })).toMatchObject({ logging: false, logRetentionDays: null });
  });

  it("对象形式即开启，并带保留天数", () => {
    expect(resolveContext({ ...base, logging: { retentionDays: 90 } })).toMatchObject({ logging: true, logRetentionDays: 90 });
    expect(resolveContext({ ...base, logging: {} })).toMatchObject({ logging: true, logRetentionDays: null });
  });

  it("保留天数非正整数 → 抛错", () => {
    for (const retentionDays of [0, -1, 1.5, Number.NaN]) {
      expect(() => resolveContext({ ...base, logging: { retentionDays } })).toThrow(/retentionDays/);
    }
  });
});
