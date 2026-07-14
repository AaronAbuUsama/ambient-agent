# Vite+ for the application CLI package

Status: research snapshot, 2026-07-14

## Recommendation

Adopt **Vite+ 0.2.4 for CLI packaging and the test command**: use `vp pack` to compile `src/cli/main.ts` into the npm `bin` target and `vp test` for Vitest 4. Keep `flue build --target node` as the server build. After the user explicitly selected Effect 4, the repository could move to `effect@4.0.0-beta.98`, `@effect/vitest@4.0.0-beta.98`, and Vitest 4 together instead of retaining the earlier Vitest 3 constraint.

Do not use `vp build` for the CLI. That command builds Vite applications with Rolldown; `vp pack` builds libraries and Node CLI artifacts with tsdown, which is itself powered by Rolldown. Do not enable `pack.exe`: that is experimental Node Single Executable Application output, requires Node 25.7 or newer at build time, and solves a different problem from a normal npm package that runs on Node 22.

This is still a deliberate migration: Vite+ owns packing and testing, while Flue continues to own the server build and no Vite application build is introduced. Vite+ is currently a public beta, officially described as “stable, but not yet complete.” Pin the version and lockfile while it is pre-1.0.

Primary sources: [Vite+ beta announcement](https://voidzero.dev/posts/announcing-vite-plus-beta), [Vite+ Pack guide](https://viteplus.dev/guide/pack), [Vite+ Build guide](https://viteplus.dev/guide/build), and [tsdown executable guide](https://tsdown.dev/options/exe).

## Product and command names

Vite+ has two pieces:

- `vp` is the global command-line tool.
- `vite-plus` is the project-local npm package. Its npm binary is also named `vp`.

The current release is `vite-plus@0.2.4`. Its declared Node range is `^20.19.0 || ^22.18.0 || >=24.11.0`. The installed Ambient Agent CLI supports `>=22.19.0`, while building this repository from source requires the intersection of those ranges: `^22.19.0 || >=24.11.0`. In particular, Node 23 and Node 24.0-24.10 satisfy the installed CLI range but cannot run this Vite+ release. Vite+ can manage Node itself, but the local package and lockfile are what make repository and CI behavior reproducible.

Sources: [Getting Started](https://viteplus.dev/guide/), [`vite-plus@0.2.4` package manifest](https://github.com/voidzero-dev/vite-plus/blob/v0.2.4/packages/cli/package.json), and [Vite+ environment resolution](https://viteplus.dev/guide/env).

## Concrete packaging shape

Vite+ keeps tsdown options under `pack` in `vite.config.ts` and explicitly discourages a separate `tsdown.config.ts`:

```ts
import { defineConfig } from "vite-plus";

export default defineConfig({
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
```

`platform: "node"` is tsdown's default, ESM is its default output format, and the target is also inferred from `package.json#engines.node`; the explicit values make this executable's contract obvious. Node-platform builds otherwise default to fixed `.mjs`/`.cjs` extensions, so `fixedExtension: false` is what makes the ESM output match `dist/cli/main.js` under `"type": "module"`.

Use an ordinary source shebang as the first line:

```ts
#!/usr/bin/env node
```

tsdown preserves a detected entry shebang and grants executable permission to the emitted file. Keep the npm mapping explicit rather than enabling tsdown's still-experimental package metadata generation:

```json
{
  "type": "module",
  "files": ["dist"],
  "bin": {
    "ambient-agent": "./dist/cli/main.js"
  },
  "engines": {
    "node": ">=22.19.0"
  }
}
```

A local `vite-plus@0.2.4` smoke test confirmed that this configuration preserves `#!/usr/bin/env node`, emits `.js`, sets mode `0755`, and runs under Node 22. The packaged test suite should assert all four properties rather than treating them as implicit bundler behavior.

Sources: [Vite+ pack configuration](https://viteplus.dev/guide/pack), [tsdown smart defaults](https://tsdown.dev/guide/how-it-works), [tsdown output format](https://tsdown.dev/options/output-format), [tsdown target inference](https://tsdown.dev/options/target), [`fixedExtension` API](https://main.tsdown.dev/reference/api/interface.userconfig#fixedextension), [tsdown shebang implementation](https://github.com/rolldown/tsdown/blob/main/src/features/shebang.ts), and [npm `bin` documentation](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#bin).

## Coexistence with the Flue server build

Before the Vite+ migration in issue #46, the repository used:

```json
{
  "scripts": {
    "build": "flue build --target node",
    "start": "node --env-file-if-exists=.env dist/server.mjs"
  }
}
```

Source: [`package.json`](../../package.json).

The installed `@flue/cli@1.0.0-beta.9` already builds its Node server with Vite 8 and writes `dist/server.mjs`. Its production builder sets `configFile: false`, so the new root `vite.config.ts` does not replace or configure Flue's authored server build. It also builds with `emptyOutDir: true`, however, so a Flue build clears `dist`.

Consequently, keep the outputs in separate subtrees and make the combined build order explicit: Flue first, CLI second.

```json
{
  "scripts": {
    "build:server": "flue build --target node",
    "build:cli": "vp pack",
    "build": "pnpm run build:server && pnpm run build:cli",
    "prepack": "pnpm run build"
  }
}
```

`vp build` is a reserved built-in Vite application command. If a developer wants the `package.json` script named `build`, the Vite+ spelling is `vp run build`; ordinary `pnpm run build` remains valid.

Sources: [`flue build` reference in the installed package](../../node_modules/@flue/cli/docs/cli/build.md), [`@flue/cli@1.0.0-beta.9` build implementation](../../node_modules/@flue/cli/dist/flue.js), [Vite+ command distinction](https://viteplus.dev/guide/), and [Vite+ Build guide](https://viteplus.dev/guide/build).

## Tarball proof

`vp pack` compiles the package; it does not create the npm tarball. The acceptance path remains:

```bash
pnpm run build
pnpm pack
```

The test should inspect the generated `.tgz`, install that tarball into an isolated temporary prefix and home, and invoke the installed `ambient-agent` shim. It should check:

- `package.json#bin` points at an included file.
- The emitted entry begins with the Node shebang and is executable on POSIX.
- No source-only files or credentials are included.
- The CLI runs under the declared Node 22.19 floor.
- Runtime dependencies are installed and resolve from the tarball installation.

The final point matters because tsdown externalizes packages listed in `dependencies`, `peerDependencies`, and `optionalDependencies`; it bundles imported development dependencies. Runtime libraries and native packages must therefore stay in `dependencies`, and copying only `dist` is not an adequate smoke test.

Sources: [tsdown dependency behavior](https://tsdown.dev/guide/how-it-works), [pnpm `pack`](https://pnpm.io/cli/pack), and [npm package contents](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#files).

## Effect 4 decision update

The initial research found that the existing `@effect/vitest@0.29.0` constrained the repository to Vitest 3. The user then explicitly selected Effect 4. The matching `@effect/vitest@4.0.0-beta.98` accepts Vitest 4, so the implementation uses Vite+'s bundled Vitest 4.1.10 and rewrites ordinary Vitest imports to `vite-plus/test`. Effect virtual-clock tests continue to import `@effect/vitest`.

The migration deliberately stops short of replacing Flue's production builder, adding Vite application output, or adopting unrelated Vite+ lint/format policy. The build order remains Flue first and Vite+ Pack second because Flue empties `dist`.

Sources: [Vite+ migration guide](https://viteplus.dev/guide/migrate), [`vite-plus@0.2.4` package manifest](https://github.com/voidzero-dev/vite-plus/blob/v0.2.4/packages/cli/package.json), [`@effect/vitest@0.29.0` npm metadata](https://registry.npmjs.org/@effect/vitest/0.29.0), and the repository's [`package.json`](../../package.json).

## Decision rubric

Scores are out of 5 for issue #46.

| Option                                  | Floor-first | Reversibility | Small blast radius | Correctness / integrity | Parallelizability | Existing fit |     Total |
| --------------------------------------- | ----------: | ------------: | -----------------: | ----------------------: | ----------------: | -----------: | --------: |
| Vite+ pack + test with Effect 4         |           5 |             4 |                  4 |                       5 |                 5 |            5 | **28/30** |
| Full Vite+ application/tooling takeover |           3 |             3 |                  2 |                       3 |                 2 |            2 | **15/30** |
| Keep an ad hoc TypeScript compile       |           3 |             5 |                  4 |                       3 |                 4 |            3 | **22/30** |

The implemented recommendation is **Vite+ Pack plus Vite+ Test on Effect 4**, with Flue retained as the server builder.
