import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: {
    // Source tests stay Bun-native for `bun test`; Vitest receives the same
    // test API through this compatibility alias when `vp test` runs them.
    alias: {
      "bun:test": "vitest",
      // OpenTUI publishes this extensionless subpath for Bun. Node's ESM
      // resolver, used by Vitest, needs the concrete file.
      "react-reconciler/constants": "react-reconciler/constants.js",
    },
  },
  ssr: {
    // Keep OpenTUI inside Vite's module pipeline so the Node-specific alias
    // above is applied during Vitest collection.
    noExternal: ["@opentui/react", "react-reconciler"],
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    // Rendering journeys require OpenTUI's Bun FFI. `vp run test` executes the
    // complete Bun suite; `vp test` covers every runtime-independent test.
    exclude: ["src/app.journey.test.tsx"],
    server: {
      deps: {
        inline: ["agentic-tui-kit", "@opentui/react", "react-reconciler"],
      },
    },
  },
  staged: {
    "*": "vp check --fix",
  },
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
});
