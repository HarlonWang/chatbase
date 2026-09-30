import path from "node:path";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

// unit：node 环境、D1 用 mock；d1：跑在 workerd 里，env.DB 是真 D1，只锁依赖 D1 语义（batch 内 changes()）的账本不变量
const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
          exclude: ["test/d1/**", "**/node_modules/**"],
        },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.toml" },
            miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
          }),
        ],
        test: {
          name: "d1",
          include: ["test/d1/**/*.test.ts"],
          setupFiles: ["test/d1/apply-migrations.ts"],
        },
      },
    ],
  },
});
