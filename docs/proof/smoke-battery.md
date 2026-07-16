# Smoke battery — live proof

Date: 2026-07-16

Ticket: [#116](https://github.com/AaronAbuUsama/ambient-agent/issues/116)

This records the packed CLI running the complete smoke battery against the real installation, runtime, GitHub repository, and dedicated managed WhatsApp canary group.

## Rig

- Host: `code-factory` (user `abuusama`)
- Persistent runtime: tmux session `validate-88`, pane `1.1`
- Tarball: `$HOME/validate-88/ambient-agent-0.2.2-issue116.tgz`
- Packed artifact SHA-256: `5d879dd753964a370187dfb13b125c971cec754098cc5499be2d681b50a19ad6`
- Runtime health endpoint: `http://127.0.0.1:42069/health`
- Canary group: the paired account's dedicated managed TST group

The runtime was started from the same packed artifact:

```sh
npx --yes --package=file:$HOME/validate-88/ambient-agent-0.2.2-issue116.tgz ambient-agent start
```

## Smoke command and output

Run from `$HOME` on `code-factory`:

```sh
npx --yes --package=file:$HOME/validate-88/ambient-agent-0.2.2-issue116.tgz ambient-agent smoke
```

Real output:

```text
(node:3215420) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
PASS installation: managed installation ready
PASS chatgpt: authentication ready; live readiness complete
PASS runtime: healthy; WhatsApp online
PASS backlog: 0 pending, 0 failed, no Uncertain work
PASS github: access to AaronAbuUsama/ambient-agent
PASS canary: SMOKE 8a3d75feba40 settled silent (admission → dispatch → settled-silent)
```

The persistent runtime independently rendered the canary lifecycle:

```text
6:34:23 PM  ← [Ambient Agent] SMOKE 8a3d75feba40 — ignore
6:34:26 PM  ▶ [AGENT] Processing: 1 message
6:34:28 PM  ✓ [AGENT] Completed: 1.5s
6:34:28 PM  — settled silent
```

## Checklist

- [x] Installation inspection passed for the managed installation.
- [x] ChatGPT authentication and live readiness passed.
- [x] The runtime health endpoint reported healthy with WhatsApp online.
- [x] The durable backlog had no pending, failed, or Uncertain work.
- [x] GitHub access to `AaronAbuUsama/ambient-agent` passed.
- [x] A nonce-bearing canary entered the dedicated managed group.
- [x] The observer correlated admission, dispatch, and settled-silent before the timeout.
- [x] No Say was emitted for the canary.

## Provider behavior established during validation

The first live attempt established that whatsappd acknowledges a self-send with a provider message ID, but exposes the account's copy later as history rather than as a fresh live callback. The final canary therefore waits for the real provider acknowledgement, retains that conversation fact as outbound, marks exactly that acknowledged message ID for application admission, and then uses the normal Window, dispatch, agent, and observer path. Ordinary self-authored messages and historical messages remain excluded.

## Automated verification

Final branch checks:

```sh
pnpm build
pnpm exec vp lint
pnpm typecheck
pnpm test
pnpm evals
git diff --check
```

Build and TypeScript checks passed. Lint had no errors and retained two pre-existing warnings outside the changed files. The full suite passed with 349 tests and 3 intentional skips. Deterministic evals passed 8 tests; 8 live-provider cases remained intentionally gated.

## Proof boundary

- **Live-runtime proof:** packed artifact, real paired WhatsApp send and provider acknowledgement, exact application admission in the real managed canary group, installation/ChatGPT/runtime/backlog/GitHub stations, and exact-Window observer-correlated silent settlement.
- **Automated proof:** station failure reporting, canary configuration validation, exact-message admission, observer subscription, timeout behavior, and silent-settlement correlation.
- **Not claimed:** the provider does not furnish a fresh live self-message callback. Admission is an explicit application action gated by the exact provider-acknowledged message ID; it is not evidence of a provider live echo or a second participant's inbound transport.
