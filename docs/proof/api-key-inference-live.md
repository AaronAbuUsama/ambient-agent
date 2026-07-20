# API-key model provider — live inference receipt

Date: 2026-07-20

Ticket: #250 · Plan: `docs/planning/ONE-BOX-PLAN-2026-07-20.md` § M1

Branch: `claude/issue-250-api-key-provider` (off `claude/single-box-working`)

## What shipped

The model provider is an API-key choice set through the CLI. Not "add OpenAI" —
any of the 35 providers pi ships is selectable, because they all share one
`createProvider` shape and every api id they name (`openai-responses`,
`anthropic-messages`, …) is already registered by `registerBuiltInApiProviders()`
at import (`pi-ai/dist/compat.js:136`). Binding one is a single
`registerProvider(id, {apiKey})` and never a `registerApiProvider`.

```text
ambient-agent config --model-provider openai \
  --model gpt-5.4 --model-speaker gpt-5.4-mini --model-scribe gpt-5.4-mini
```

The key is pasted at a prompt. It is never a flag, never an environment
variable, and never written to `config.json` — it lands in
`credentials/model-api-key.json` at mode 0600 and config references it by the
name `api-key`.

The Codex subscription path is untouched. `connectPiChatGptSubscription` and the
Luna Responses-Lite rewrite are byte-identical to `claude/single-box-working`,
for whenever a subscription returns.

## Rig

The gate runs the **real built CLI and the real runtime**
(`dist/cli/main.js`, built by `pnpm run build:dist`) against a managed
installation in a scratch directory. `tests/fixtures/packed-runtime.mjs` stubs
the WhatsApp socket, Octokit and the e2b SDK by module hook, and passes
`https://api.openai.com` through to the real network while recording every
request and the usage its stream reports.

**Recorded limitation ❌** — the WhatsApp *socket* is a stub, so the message
enters through the managed-chat path (`120363000@g.us`, the configured managed
chat) rather than over a paired WhatsApp session. Everything above the socket —
managed-chat admission, coalescer, Speaker dispatch, provider binding — is the
production code path. A gate over a genuinely paired thread has **not** been run
here; that belongs on the code-factory rig.

```bash
G=<scratch>/gate
cd /home/abuusama/ambient-agent
pnpm run build:dist

HOME=$G/home XDG_DATA_HOME=$G/home/.local/share \
node --import=tests/fixtures/packed-runtime.mjs dist/cli/main.js \
  --data-dir $G/managed init --authorize \
  --chat 120363000@g.us --repository owner/repo --github-apps-file $G/apps.json
```

```text
Data directory: <scratch>/gate/managed
Open https://auth.openai.com/codex/device and enter code PACK-TEST.
ChatGPT authorization complete.
Created secure managed installation at <scratch>/gate/managed.
```

## The CLI surface

```bash
node dist/cli/main.js config --help
```

```text
Options:
  --model-provider <id>      model provider ID; the API key is pasted at the
                             prompt, never a flag
  --model <id>               model ID for every agent role
  --model-speaker <id>       model ID for the Speaker (a cheap model is fine
                             here)
  --model-scribe <id>        model ID for the Scribe
  --model-planner <id>       model ID for the Planner
  --model-coder <id>         model ID for the Coder
  --model-verifier <id>      model ID for the Verifier
```

Per-role profiles are the cost lever. The Speaker and Scribe run on
`gpt-5.4-mini`; the Planner, Coder and Verifier stay on `gpt-5.4`.

## Negative 1 — no inference means no boot

`model.provider` is `openai` and `credentials/model-api-key.json` is absent.
The assertion is the **process exit code**, not a log line.

```bash
ls $G/managed/credentials/          # chatgpt-oauth.json, github-{coder,reviewer,planner}.json
HOME=$G/home XDG_DATA_HOME=$G/home/.local/share \
node --import=tests/fixtures/packed-runtime.mjs dist/cli/main.js \
  --data-dir $G/managed start
echo "EXIT CODE: $?"
```

```text
ambient-agent: model.provider is openai but the managed API key at
<scratch>/gate/managed/credentials/model-api-key.json is missing or unreadable.
Run ambient-agent config --model-provider openai and paste a fresh key.
EXIT CODE: 1
```

✅ Exit code 1. Nothing bound: the credential is read in
`startGeneratedRuntime` before `installManagedRuntimeDependencies` and before
the generated server is imported. `tests/managed/model-provider-start.test.ts`
asserts the same in-process, including that `importServer` is never called, and
covers the second shape of the failure — a key pasted for a different provider
than the config names.

## Negative 2 — a provider/credential mismatch is refused at config-write time

`writeManagedConfiguration` re-parses through `ManagedConfigSchema`, whose
`v.check` pairs provider and credential, before it touches either file.

```bash
npx tsx $G/mismatch.mts $G/managed
```

```text
REFUSED at write time: The model credential reference must match the configured model provider
config unchanged on disk: true
provider still: openai / credential: api-key
```

✅ Refused before any write, so it cannot be discovered at first inference.
`tests/managed/configuration.test.ts` asserts the same and additionally that the
injected write function is never called and both files are byte-identical
afterward.

## Dry run — the request reaches the provider

Run first with a deliberately invalid key, so the wire is proven before any
funds are spent.

```bash
PACKED_PROVIDER_ORIGIN=https://api.openai.com \
PACKED_PROVIDER_LOG=$G/provider.jsonl \
PACKED_WHATSAPP_SEND_LOG=$G/sends.jsonl \
PACKED_WHATSAPP_INPUT="@bot Reply with the single word READY." \
node --import=tests/fixtures/packed-runtime.mjs dist/cli/main.js \
  --data-dir $G/managed start
```

```json
{"kind":"request","url":"https://api.openai.com/v1/responses","model":"gpt-5.4-mini","at":1784532019180}
{"kind":"response","url":"https://api.openai.com/v1/responses","status":401,"elapsedMs":468}
```

✅ The request left the process and reached OpenAI, carrying the Speaker's own
per-role model `gpt-5.4-mini`. HTTP 401 is the correct answer to a bogus key.

## Gate — a real reply

❌ **Not yet observed.** Awaiting a real API key pasted at the prompt.

| Measure | Value |
|---|---|
| Model id | ❌ not observed |
| Reply arrived | ❌ not observed |
| Turns | ❌ not observed |
| Tokens (input / output) | ❌ not observed |
| Wall time | ❌ not observed |
| Cost | ❌ not observed |

## Verdict

| Claim | Evidence | Verdict |
|---|---|---|
| Provider is an API-key choice set through the CLI | `config --model-provider <id>` accepts any of pi's 35 provider ids | ✅ |
| The key is never a flag or an environment variable | Prompted; non-interactive selection is refused | ✅ |
| The key is never in `config.json` | Config carries `credential: "api-key"`; file is mode 0600 | ✅ |
| Per-role models | `--model-<role>`; Speaker ran `gpt-5.4-mini` while Coder points at `gpt-5.4` | ✅ |
| Codex subscription path untouched | No diff to `connectPiChatGptSubscription` or the Luna rewrite | ✅ |
| Existing configs parse unchanged | `provider` is `v.optional(…, "openai-codex")`; no migration, no schemaVersion bump | ✅ |
| Runtime exits non-zero with the credential absent | Exit code 1 | ✅ |
| Mismatch refused at config-write time | Write refused, both files unchanged | ✅ |
| The request reaches the provider | `POST https://api.openai.com/v1/responses`, model `gpt-5.4-mini` | ✅ |
| A real reply arrives | — | ❌ not yet observed |
| Reply quality | Not asserted, by design | n/a |
| Gate over a paired WhatsApp thread | Socket is stubbed on this box | ❌ not observed |

## Checks

```bash
npx tsc --noEmit     # clean
npx vitest run tests/
```

```text
 Test Files  70 passed | 1 skipped (71)
      Tests  686 passed | 3 skipped (689)
```

The four `tests/packaging/packed-cli.test.ts` failures that predate this branch
are fixed here too: e2b's CJS entry `require`s a package-internal
`#ansi-styles` subpath import that the fixture's module hooks could not link,
so every packed-CLI run died at import. The fixture now stubs `e2b`, which the
CLI imports statically but only constructs when `E2B_API_KEY` is set.

## Rollback

`ambient-agent config --model-provider openai-codex` returns to the subscription
path, which is untouched.
