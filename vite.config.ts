import { defineConfig } from "vite-plus";

// The test-mode SKILL.md stub is gone with #375: every skill body is now imported as text (`?raw`,
// which Vite serves natively) and turned into a real skill reference from the prompt store, so the
// tests exercise the same skill construction production does.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup-prompt-store.ts"],
    restoreMocks: true,
  },
  fmt: {
    printWidth: 120,
  },
  pack: {
    noExternal: [/^@ambient-agent\//],
    entry: {
      main: "apps/cli/src/main.ts",
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
