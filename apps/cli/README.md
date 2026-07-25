# apps/cli — the `ambient-agent` CLI

The operator's application: the no-subcommand **control plane**, plus `init / auth /
config / repair / start / status / doctor / smoke`. Bundled by `vp pack` into the
published `ambient-agent` bin.

## Structure

| File | Role |
|---|---|
| `src/main.ts` | Bin entry: `runCli(process.argv.slice(2))`. |
| `src/program.ts` | The Commander program; all commands. `CliDependencies` / `CliOutput` are the test seams (`tests/managed/cli.test.ts` drives every command through them). |
| `src/setup/first-run.ts` | Interactive/scripted first-run setup: chat selection, GitHub discovery, WhatsApp pairing or store import — all effects behind `FirstRunServices` + `FirstRunPrompts`. |
| `src/setup/github.ts` | Origin-repo and credential discovery, repository access verification. |
| `src/control-plane.ts` | What no subcommand means (#364): a token-gated HTTP control plane on its own port, bound for the life of the process, with the runtime brought up behind it in the same process and a boot failure captured as `RuntimeBoot` rather than thrown. Defines the bearer-token scheme, the `/api/` route shape, and the boot-failure value later nodes consume. |
| `src/lifecycle.ts` | Boots the packed server runtime: installs runtime dependencies into the `globalThis` slot **before** importing the generated bundle, then starts the deferred WhatsApp runtime. Order is load-bearing — see `@ambient-agent/installation/runtime-dependencies.ts`. |
| `src/inspection.ts` / `src/rendering.ts` | Status/doctor data gathering and terminal rendering. |
| `src/prompts.ts` | `@clack/prompts` wiring: setup prompts, device-code and pairing callbacks. |
| `src/smoke.ts` | The smoke-canary request path and station rendering. |

## Dependency arrows

Imports `@ambient-agent/installation` (heaviest) and `@ambient-agent/engine`.
**Never** imports `@ambient-agent/agents` — the CLI operates the installation; it does
not think (enforced by `tests/speaker/hard-cut.test.ts`).

## Tested by

`tests/managed/{cli,control-plane,smoke}.test.ts`, `tests/setup/`, and the end-to-end pack test
`tests/packaging/packed-cli.test.ts` (runs the actual packed bin).
