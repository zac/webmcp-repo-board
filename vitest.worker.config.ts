import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: {
      bindings: {
        ENVIRONMENT: "test",
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY: "test-only",
        GITHUB_APP_CLIENT_SECRET: "test-only",
        GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
        TEST_MIGRATIONS: migrations,
      },
    },
  })],
  test: {
    include: ["src/worker/**/*.worker.test.ts"],
  },
});
