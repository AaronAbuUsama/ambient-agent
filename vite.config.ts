import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
  staged: {
    "*": "vp check --fix",
  },
  // Agent/editor config dirs are not application source.
  fmt: { ignorePatterns: ["**/.claude/**", "**/.agents/**"] },
  lint: {
    ignorePatterns: ["**/.claude/**", "**/.agents/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
});
