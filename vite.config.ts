import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    restoreMocks: true,
  },
  fmt: {
    printWidth: 120,
  },
  pack: {
    entry: {
      main: "src/cli/main.ts",
    },
    outDir: "dist/cli",
    format: "esm",
    platform: "node",
    target: "node22.19.0",
    fixedExtension: false,
    dts: false,
    sourcemap: true,
  },
});
