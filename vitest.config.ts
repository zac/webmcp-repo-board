import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/shared/**/*.test.ts", "src/client/**/*.test.ts"],
    passWithNoTests: true,
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
