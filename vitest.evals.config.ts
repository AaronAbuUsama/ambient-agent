import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/agents/evals/**/*.eval.ts", "packages/agents/src/capabilities/*/evals/*.eval.ts"],
    reporters: ["default", "vitest-evals/reporter"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
