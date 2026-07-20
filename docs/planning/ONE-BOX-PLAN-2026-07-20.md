# One box, working end to end

**2026-07-20.** Supersedes the staged rebuild in `REBUILD-PLAN-2026-07-19.md` as the *active* plan.
That document stays for its measured findings; this one is what gets built.

## The goal, in one sentence

**One VPS, one instance, one operator. A message in WhatsApp produces a real reply, files a real
GitHub issue, and opens a real PR — and survives a reboot.**

Everything else is deferred: multi-tenancy (dropped), the web app (later), E2B (later), billing
(later), backup (later).

## Owner decisions this plan encodes

Confirmed directly, 2026-07-19 → 2026-07-20:

1. **Single instance.** No tenants. Two companies live inside it as chats + GitHub orgs.
2. **No environment variables.** Everything configurable through the CLI into managed config.
3. **Deploy on the VPS**, not the laptop. Handoff to an agent working on the box.
4. **One sandbox**, shared by Coder and Reviewer.
5. **Local sandbox is acceptable.** Single operator, nobody else in the group, far from SaaS.
6. **Inference comes from an API key** — no subscription is available. The owner has an OpenAI key
   with **limited funds**, so a cheap model for now and not production-ready. Minimum viable.
7. **Issues must work.** Filing a GitHub issue from chat is part of "working".

## What is actually true today — measured, not assumed

| Claim | Reality |
|---|---|
| "The Reviewer uses a Docker sandbox" | **False.** `bc93fb9` deleted `reviewer-docker-sandbox.ts` and its test. Zero docker sandbox references remain. |
| "Coder and Reviewer need unifying" | **Already unified.** `apps/runtime/src/app.ts:112-113` passes one factory to both; `coder/runtime.ts:14-18` and `reviewer/runtime.ts:5-9` are byte-identical on the sandbox field. |
| "The Coder is blocked on the E2B key" | **False.** `local()` (`@flue/runtime/node`, `dist/node/index.d.mts:45`) is a complete `SandboxFactory`, still installed, currently with **zero imports**. `bc93fb9` deleted the call site that used it. |
| "The CLI depends on the web/SaaS stack" | **False.** Traced transitively from `apps/cli/src/main.ts`: 48 files, reaching only `apps/cli`, `packages/engine`, `packages/installation`, `packages/agents`. F-3/F-4 do not block the CLI. |
| "The CLI needs env vars to run" | **False.** Zero required. Only 6 optional ones matter and all 6 move to config here. |
| "We need a tunnel for the demo" | **False for outbound.** WhatsApp → Speaker → Coder → PR is entirely outbound. A tunnel is only needed for GitHub → agent. |
| "pi can reuse a `pi login` on the box" | **False.** `pi-ai` is a library with no credential storage; `loadAnthropicOAuth` only imports the flow module. The app owns the store — as this repo already does for ChatGPT. |
| "Nothing has been proven" | **False.** WhatsApp pairing + sends, session survival across restart, real signed webhook delivery, a real draft PR from `ambient-coder[bot]`, and a self-cleaning live GitHub issue test all have receipts. |
| "It has been run end to end" | **False, and this is the real gap.** Every receipt is piecemeal, on the `code-factory` rig, via a packed tarball. No completed install exists anywhere. |

## The one rule, unchanged

**Every gate is a real-world proof, and every gate asserts a negative.** The dominant failure mode
here is silent degradation. Two live instances of it, both fixed below:

- **The Reviewer fabricates a review on model silence** — `reviewer/workflow.ts:143-153` posts a real
  GitHub review with `missingModelVerdict = true` and returns non-error success, shaped identically
  to a genuine COMMENT.
- **No 429 handling exists anywhere** — `pi-subscription.ts:247-257` classifies a rate limit as
  `request-failed`, indistinguishable from a network blip.

---

# The order

```
M1 Anthropic inference ──▶ M2 Sandbox selector ──▶ M4 Run it on the box ──▶ M5 Inbound GitHub
        │                        │                        │
        └──▶ M3 Env → CLI config ┘                        └──▶ M6 Eyes on it
```

**M1 is first because nothing else can be verified without inference.** Every downstream gate drives
the model.

## M1 · Anthropic inference — minimum viable

There are no OpenAI credits. Without this, nothing can be proven for a week.

**Why it is small:** `anthropic-messages` is a **built-in** Flue api id
(`pi-ai/dist/compat.js:107,136` calls `registerBuiltInApiProviders()` at import), so unlike the Codex
path there is **no `registerApiProvider`**. pi handles all header/body adaptation. The Luna rewrite
(`pi-subscription.ts:116-190`) is gated on the Codex URL and model id (`:120`, `:168`) and never
fires — leave it alone. Agents are untouched: all five go through `resolveAgentModelProfile`.

**Scope — API key only.** Deliberately dropped: the OAuth flow, doctor readiness routing, first-run
provider selection, profile tuning. pi ships a full Claude Pro/Max PKCE flow
(`utils/oauth/anthropic.js`) with a headless paste-the-redirect path; adding it later is additive,
and the credential shape is already byte-identical to `ChatGptOAuthCredentialSchema`.

| File | Change | ~Lines |
|---|---|---|
| `packages/installation/src/schema.ts:49-54` | `provider` → `v.picklist(["openai-codex","anthropic"])`; add `anthropic` credential reference; `v.check` pairing provider↔credential | 12 |
| `packages/installation/src/paths.ts:16-27,80-90` | `credentials/anthropic.json` | 4 |
| `packages/engine/src/model/pi-subscription.ts:40,297-321` | `modelSpecifier(provider, id)` (`:40` hardcodes `openai-codex`); `connectPiAnthropic` — `registerProvider` only | 35 |
| `apps/runtime/src/app.ts:102` | branch on `configuration.model.provider` | 5 |
| `apps/cli/src/program.ts` | `config --model-provider <openai\|anthropic>`, key via prompt not flag | 20 |

**Gate:** with `provider: "anthropic"` and a real key, send a message to the managed chat and get a
real reply generated by Claude. Record model id, turns, wall time.
**Negative:** with the credential file absent, the runtime must **fail loudly at start**, not boot
and settle silent. Assert a non-zero exit, not a log line.
**Receipt:** `docs/proof/anthropic-inference-live.md`.
**Rollback:** `config --model-provider openai-codex`. The schema change is additive; existing configs
parse unchanged.

## The cheap-model trap — read before spending anything

Funds are limited, so gates will run on a nano-class model. That creates a specific and expensive
failure mode:

**A cheap model failing at a task is indistinguishable from the code being broken.** The Coder green
path has never once worked. If a nano model is pointed at it and the run fails, we cannot tell
whether the plumbing is broken or the model simply could not write the code — and the tempting
conclusion is the wrong one.

**Therefore every gate splits in two:**

| | Asserts | Cheap model? |
|---|---|---|
| **Plumbing** | the request left, the response parsed, a tool was invoked, a sandbox `exec` succeeded, a branch was created, a PR opened, the run settled | **Yes — run now** |
| **Capability** | the diff is correct, the verifier returns `PASS` | **No — deferred until funds allow** |

The thing believed to be broken (#172: `/tmp` mounted `noexec`, `EACCES` when the model spawns a
binary) is **a filesystem fact, not a model capability**. A plumbing gate proves or refutes it for
near-zero spend. That is the highest-value measurement available right now, and it is cheap.

**Per-role profiles are the cost lever.** `AgentModelProfilesSchema` already supports a model per
role (`resolveAgentModelProfile`, `pi-subscription.ts:46-49`). Put the Speaker on nano — chat
replies are well within it — and leave the Coder role pointed at something capable rather than
spending funds proving a cheap model cannot write code.

## M2 · One sandbox, selectable, config-driven

Unblocks the Coder and Reviewer without E2B. Owner has accepted the local-shell exposure (single
operator, his own repos, attended).

The resolver must return **sandbox and `workspacesRoot` together** — `workspacesRoot` is hardcoded to
`E2B_WORKSPACES_ROOT` (`/home/user/workspaces`, `e2b-sandbox.ts:13`), which does not exist on a host.
With `local` it must be `paths.workspaces` (`paths.ts:94`).

Use `local(options?)` from `@flue/runtime/node` — **verified**, and exactly what `bc93fb9` deleted.
Not `bash(factory)`, which is the lower-level adapter.

| File | Change | Δ |
|---|---|---|
| `packages/installation/src/schema.ts:57-60` | `runtime.sandbox` = `{kind: "local"\|"e2b", template?}`, default `local` | +8 |
| `apps/cli/src/lifecycle.ts:36-42` | takes config not env; returns `{sandbox, workspacesRoot}` | +12/−10 |
| `packages/installation/src/e2b-sandbox.ts:190` | explicit `apiKey` into `Sandbox.create` (SDK supports it) | +4 |
| `packages/installation/src/runtime-dependencies.ts:20` | carry the pair, non-optional | +3/−4 |
| `apps/runtime/src/app.ts:18,48-84` | drop the E2B import and **both** `if (sandbox === undefined)` guards | +6/−14 |

**The `app.ts` diff is negative** — the two silent-disable paths disappear, because a sandbox is
always available. That closes the boot-green-with-specialists-absent hole for free.

**Retain #172's fix:** `TMPDIR` must point inside the workspace, not `/tmp` (which is `noexec` on the
rig). `e2b-sandbox.ts:146,214` already does this for E2B; the local branch needs the same.

**Gate — split (see the cheap-model trap above).**

*M2a · plumbing, runs now on a cheap model.* From the managed chat, ask for a code change and assert
the **mechanics**: `start_coder_job` is invoked and a run lands in the ledger
(`capabilities/delegation/ledger.ts:49`); a sandbox session is created and `exec` **succeeds inside
it** — this is the model-independent #172 proof; the tarball unpacks; a branch is created; a PR is
opened by `ambient-coder[bot]`; the run settles rather than hanging.
*Negative:* the process must not boot green with the sandbox misconfigured, and a sandbox `exec`
failure must surface as a **failed run**, not a silent skip.

*M2b · capability, deferred until a capable model is affordable.* `verdict === "PASS"` **and** a
non-empty diff. Draft-ness alone proves nothing — a legitimate `SKIP` also yields a non-draft PR.

**Receipt:** `docs/proof/coder-green-local.md`. **M2a is the thing that has never worked, and it is
cheap to settle.**

## M3 · Env vars → CLI config

Hard requirement: no environment variables. Only **6** actually matter.

| Var | Destination |
|---|---|
| `E2B_API_KEY` | `credentials/e2b.json` (secret) |
| `E2B_TEMPLATE` | `runtime.sandbox.template` (M2) |
| `BRAINTRUST_TRACING` | `runtime.tracing.enabled` |
| `BRAINTRUST_API_KEY` | `credentials/braintrust.json` (secret) |
| `BRAINTRUST_PROJECT_NAME` / `_ID` | `runtime.tracing.project` |

Everything else is test-only (`*_FIXTURE_READY`, `*_LIVE_*`, `FLUE_BASE_URL`) and **stays an env
var**, or dies with the provisioner (`TENANT_DB_*`, `AMBIENT_AGENT_RUNTIME_*`, `PORT`,
`packages/env/src/server.ts`).

**Follow the `runtime.port` pattern exactly** — it is the worked example, five steps:
validator+field (`schema.ts:27,58-60`) → creation default (`:126-137`) → **`CONFIG_ISSUE_PATHS`
(`installation.ts:26-57`) — the most-forgotten step** → CLI flag + merge
(`program.ts:341-346,483,494-506`) → runtime read (`lifecycle.ts:70,92`).

**One structural change:** `braintrust.ts:7,9,22` reads env at **module-load time**, which cannot see
a config file read later. It becomes `configureBraintrustTracing({apiKey, project})` called from
`startGeneratedRuntime` beside `configureLogging` (`lifecycle.ts:64-68`).

**Migration: none.** Every addition is `v.optional(…, default)`, so existing configs parse unchanged
— the precedent is `runtime`, `profiles` and `reviewRepositories`. No `schemaVersion` bump.
If `E2B_API_KEY` is in the environment, print a warning naming `config --sandbox e2b`. Nothing more.

**Gate:** `env -i` (empty environment) + `ambient-agent start` runs fully configured — sandbox,
tracing and model all from `config.json` and `credentials/`.
**Negative:** setting `E2B_API_KEY` in the environment must **not** change behaviour. Assert config
wins, so the env path is genuinely dead rather than a silent fallback.

## M4 · Run it on the box, and survive a reboot

**Use the tarball, not Docker.** The tarball is the proven unit — every receipt uses
`npx --package=file:…ambient-agent-*.tgz`. `apps/runtime/Dockerfile`'s `CMD` is `dist/cli/setup.js`,
the deleted provisioner's entry, and has never run standalone. It also costs 5-6 GB to build on a box
with ~19 GB free at ~80%.

1. `pnpm install --frozen-lockfile && pnpm pack --pack-destination ./artifacts` (prepack runs
   `build:dist`). **Record the SHA-256** — every proof doc does.
2. `npm install -g ./artifacts/ambient-agent-*.tgz` on capxul-vps.
3. **`ambient-agent init` inside `tmux` over SSH.** SSH allocates a PTY so `program.ts:173-175` goes
   interactive. The QR renders as terminal ASCII (`qr.ts:12`, `small: true`); the ChatGPT/Anthropic
   step is a URL + code. `tmux` matters — `authenticationSignal()` is a 20-minute timeout and a
   dropped connection aborts setup.
4. `ambient-agent config --port <p>` — default 3000 collides with the compose `api` service.
5. **A systemd unit — ~12 lines that do not exist.** `Type=simple`, `Restart=always`, `User=`,
   `ExecStart=… start --log-format json`. `stopRuntimeOnSignal`
   (`apps/runtime/src/host/runtime-signals.ts`) already handles SIGTERM cleanly, so a supervisor
   works correctly; there just isn't one.

**Prerequisite (ceremony, not a gate):** someone points a phone at the terminal. There is **no
unattended WhatsApp pairing** — `first-run.ts:233-235` hard-aborts when `onPairing` fires
non-interactively. The only alternative is pairing elsewhere and importing with `--whatsapp-store`.

**Gate:** `systemctl restart`, then reboot the box; the agent comes back **without re-pairing** and
replies in the managed chat.
**Negative:** never run two replicas against one volume — Flue's durability forbids it. Assert the
second instance refuses or fails loudly rather than silently corrupting.
**Receipt:** `docs/proof/one-box-live.md`.

## M5 · Inbound GitHub

Only needed for GitHub → agent (issue comments, PR events, the Reviewer). Outbound already works
without it.

The proven shape is Cloudflare proxied A record → Caddy → `127.0.0.1:<port>`, route
`/channels/github/webhook`, `X-Hub-Signature-256` verified over exact bytes before parse, secret from
`credentials/github-planner.json` (auto-created by `ensureManagedGitHubWebhookSecret`,
`lifecycle.ts:71`). **Only the Planner App sends webhooks**; Coder and Reviewer are actors.

**Two unresolved items for the agent on the box — discovery, not assumption:**
- **Caddy vs Traefik.** capxul-vps runs Dokploy, which almost certainly owns 443. Nothing in the repo
  installs or configures Caddy; the Caddyfile exists only as a quoted block inside a proof doc.
  Traefik could reverse-proxy instead, but that combination has never been run.
- **The DNS record `ambient-agent.co-worker.tech` currently points at the code-factory rig.**
  Repointing it kills the one proven webhook path. Prefer a new hostname.

**Gate:** open a real issue in a real repo; the event is delivered, signature-verified, settles in
the ledger, and reaches the chat.
**Negative:** an unsigned probe returns **401** and lands no row.

## M6 · Eyes on it

Cheapest first. **Flue ships no UI** — `docs-api-routing-api.md:98`: *"Flue ships no admin HTTP
surface"*; `flue dev` is watch-mode only. So there is nothing to switch on there, but three things
are nearly free:

1. **Braintrust is already wired** at `apps/runtime/src/app.ts:3`, gated at `braintrust.ts:7`. Turn
   it on via M3's config and you get runs, model turns including the full prompt, tool calls and
   tasks in a hosted UI. Richest thing available, ~zero code.
2. **`export const runs`** on the coder + reviewer workflows and **`export const route`** on the
   Speaker — **3 lines total** — lights up `GET /runs/:runId` (SSE + `?meta`) and
   `GET /agents/speaker/:chatId`. Currently dark: `export const runs` has **zero hits** repo-wide.
3. **Logs already carry a stable `operatorEvent` field**
   (`speaker/activity-reporter.ts:48-71`): `tail -f … | jq 'select(.operatorEvent)'`.

**The graph has no viewer at all** (`graph/store.ts:152-178`; its only reader is
`computeGraphDigest`). Three SQL selects behind a read-only route would fix it. That is the smallest
high-value thing left, and it is **not** on the critical path.

**Gate:** a Coder run is observable end to end from an external surface while it happens.

---

# Deliberately not doing

- The web app (F-3/F-4 are real but the CLI sidesteps both entirely).
- E2B — the selector makes it a one-line config flip when the key arrives.
- Multi-tenancy, two GitHub orgs (#243/#249), billing.
- Backup/restore, a second-replica guard, a graph viewer, the Docker deploy unit.
- Anthropic OAuth — API key first; the flow is in pi when flat-rate matters.

# Known risks

- **macOS is unexercised** — every proof is Linux. Irrelevant if we go straight to the VPS, which is
  the plan.
- **The Coder green path may still not work.** The `TMPDIR` root cause (#172) is documented and the
  fix is restored, but it has never been observed green. M2 is the measurement.
- **`createWhatsAppAccount` is the riskiest surviving module** — cyclomatic 50, cognitive 60, and
  every existing test fakes it through `sessionFactory`.
- **Rate limits and the fabricated-review fallback** make live gates read as PASS when they should
  read as inconclusive. Fix before trusting any Reviewer gate.
- **`local()` puts credentials one `cat` away** — three GitHub App private keys, the model token, and
  the live WhatsApp session share the shell's mount namespace. Accepted by the owner for attended,
  single-operator use. Revisit before anything unattended or multi-party.
