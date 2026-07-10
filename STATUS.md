# STATUS

Built overnight, autonomously, while Aaron was asleep. This file is the
handoff: what's done, what was verified, what's left for a human.

## Summary

`whatsappd-github-agent` is a new, complete, public repo: an [Eve](https://eve.dev)
agent that operates a GitHub repo (create/list/get/comment/close issues,
list/get/review pull requests, read files, search code) from a WhatsApp
group, bridged over [whatsappd](https://github.com/AaronAbuUsama/whatsappd)'s
Eve adapter. It ships with 10 typed, unit-tested GitHub tools, a group-gating
channel (only the configured group, only when addressed by a trigger word),
a full step-by-step tutorial, and green CI.

Repo: **https://github.com/AaronAbuUsama/whatsappd-github-agent**

## Done

- [x] Read the Eve docs (public site + the installed `eve@0.22.4` package's
      bundled `node_modules/eve/docs/`, which is more complete and is what
      the code below actually matches) and whatsappd's source
      (`src/adapters/eve.ts`, `src/sidecar/`, `src/tools/`, `README.md`) in
      the existing `whatsapp-channel` repo — **read-only**, nothing in that
      repo was modified or pushed to.
- [x] Scaffolded a new Eve app by hand (not `eve init`, to keep full control
      of every file) at `/Users/abuusama/projects/hack-space/whatsappd-github-agent`:
      `agent/agent.ts`, `agent/instructions.md`, `agent/lib/github.ts`,
      `agent/tools/github_*.ts` (10 tools), `agent/channels/whatsapp.ts`,
      `src/index.ts` (sidecar launcher).
- [x] All 10 GitHub tools implemented with Zod input schemas and unit tests
      against a mocked Octokit client (`tests/tools/*.test.ts`, 22 tests) —
      `createIssue`, `listIssues`, `getIssue`, `commentOnIssue`,
      `closeIssue`, `listPullRequests`, `getPullRequest`,
      `reviewPullRequest` (COMMENT/APPROVE/REQUEST_CHANGES), `getFileContents`,
      `searchCode`.
- [x] Group gating implemented and tested (`agent/channels/whatsapp.ts`,
      `tests/channels/whatsapp.test.ts`, 12 tests): only the configured
      `WHATSAPP_GROUP_ID`, only when the message contains `WHATSAPP_BOT_TRIGGER`
      (default `@github-bot`); DMs ignored unless `WHATSAPP_ALLOW_DM=true`.
      This is an access-control decision, not just noise reduction — see
      docs/TUTORIAL.md §6 for why, and for the one honest limitation
      (whatsappd's sidecar wire format doesn't carry WhatsApp's real
      `mentionedJid`, so the gate matches trigger text, not a true mention).
- [x] `docs/TUTORIAL.md` — the 8-section walkthrough requested, with a
      Mermaid architecture diagram, real code snippets pulled from this
      repo (not paraphrased), and everything empirically verified against a
      live `eve dev` server while writing it (see "Verified" below).
- [x] README, MIT LICENSE (author "Aaron AbuUsama"), `.env.example`,
      `.gitignore` (`node_modules`, `dist`, `.env`, `.env.*`, `.wa-auth*/`,
      `*.log`, `.DS_Store`, plus `.eve/`/`.output/`/`.vercel/` build
      artifacts).
- [x] GitHub Actions CI (`.github/workflows/ci.yml`), Node 22 + 24 matrix,
      pushed and **confirmed green** via `gh run watch` before tagging the
      release (see "Verified").
- [x] Secret scan clean (see "Verified"); repo created public under
      `AaronAbuUsama`, pushed, description + topics set, `v0.1.0` tagged and
      released.

## Verified

- `npm install` — clean on Node 22.22.3 (one `EBADENGINE` warning from
  `eve`'s own `engines.node: >=24`, non-fatal — see the Node-version note
  below) and on Node 24.18.0.
- `npm run typecheck` (`tsc --noEmit`) — clean, zero errors, on Node 22 and 24.
- `npm test` (vitest) — **41/41 tests pass**, no network access, no real
  `GITHUB_TOKEN` — on Node 22 and 24.
- `npm run build` (`eve build`) — succeeds on Node 24.18.0: compiles all 10
  tools + the whatsapp channel with **0 discovery errors, 0 warnings**
  (`eve info` confirms all 10 tool names and the `whatsapp` channel), writes
  a runnable `.output/`. No Vercel account, `ANTHROPIC_API_KEY`, or network
  credential was needed to build — confirmed by building with dummy/unset
  credentials.
- **Live smoke test of the whole HTTP surface** (Node 24, dummy
  `GITHUB_TOKEN`/`ANTHROPIC_API_KEY` so no real API/model calls were made):
  started `eve dev --no-ui`, hit `GET /eve/v1/health` (200 OK), POSTed a
  synthetic sidecar event to the gated channel route — an **unaddressed**
  group message returned `{"ignored":true,"reason":"not addressed"}` with no
  session started, and an **addressed** one (`"@github-bot list open
  issues"`) returned `{"sessionId":"wrun_..."}`, confirming the gate and the
  session-start wiring both work end to end. No live WhatsApp connection was
  ever opened — per the guardrail, the sidecar itself was never run against
  the real paired numbers (971585700055 / 447836603208) or any other live
  WhatsApp session.
- `git grep -niE '(ghp_|gho_|sk-ant-|AKIA|-----BEGIN|api[_-]?key\s*=|secret\s*=)'`
  across the tracked tree — no matches beyond `.env.example`'s obviously
  fake placeholder values (`ghp_xxxx...`, `sk-ant-xxxx...`). `.wa-auth*/`
  and `.env` confirmed untracked (`git status` / `git check-ignore`). No
  `.wa-auth*` directory was ever created in this repo — the WhatsApp sidecar
  was never run here.
- GitHub Actions: pushed to `main`, watched the run to completion with
  `gh run watch`, **all jobs green** (Node 22: install/typecheck/test; Node
  24: install/typecheck/test/build).

## A real constraint discovered during the build (not introduced by me)

The published `eve` package (`0.21.0` through the latest `0.22.4`, i.e.
every version whatsappd's own `peerDependencies` range `>=0.21.0 <1`
allows) declares `"engines": { "node": ">=24" }`, **and enforces it at
runtime**: `eve build` / `eve dev` / `eve start` / `eve info` all print
`eve requires Node.js >=24. You are running v22.22.3.` and exit immediately
on Node 22, regardless of `engines`/`devEngines` config or `npm`'s
(non-enforcing-by-default) engine check. Importing `eve`'s *library* exports
(`eve/tools`, `eve/channels`, `defineTool`, `defineAgent`, etc.) works fine
on Node 22 — only the CLI binary itself hard-checks the version.

Since the task's CI ask ("test on Node 22 and 24... and PASSES") predates
this discovery, I resolved it the way I'd want a colleague to: kept
install/typecheck/test on both Node versions in the matrix (they all
genuinely pass on 22), and gated only the `eve build` CI step to the Node 24
leg, with a comment in `ci.yml` explaining why. Both matrix legs are green.
If a future `eve` release relaxes the Node 22 restriction, dropping that
`if:` condition is the only change needed.

## Design decisions worth knowing about

- **Group gating lives in the channel route, not just the persona.** An
  instruction can shape what the model says, but an ungated route still
  starts a (token-spending) session for every message and still lets a
  model that's unsure decide to reply anyway. `agent/channels/whatsapp.ts`
  reimplements whatsappd's `createEventRoute` with a gate checked *before*
  `args.send()` is ever called — a `Request` body can only be read once, so
  wrapping the exported `createEventRoute` from outside wasn't an option;
  the route needed to own the body parse. Reply delivery, read receipts,
  typing, and media staging are unchanged, reused directly from
  `whatsappd/adapters/eve`'s exports (`createEventHandlers`,
  `createFetchFile`, `toUserContent`).
- **DMs are opt-in, not opt-out** (`WHATSAPP_ALLOW_DM`, default false). A
  WhatsApp number receives messages from anyone; this bot can write to
  GitHub. Defaulting DMs to "ignored" was a judgment call in the direction
  of least surprise/least privilege, not something the task explicitly
  asked for — flagging it here rather than burying it.
- **The whatsappd README's own `WHATSAPP_FORWARD_URLS` example**
  (`https://my-app.example/api/channels/whatsapp/event`) **doesn't match
  how Eve actually mounts channel routes** — a channel's declared route path
  (`POST("/event", ...)`) is mounted at that literal path, not nested under
  `/channels/<name>/...`. This was caught by actually running `eve dev` and
  checking `eve info --json`'s `urlPath` field, not by reading docs. This
  repo's own `.env.example` and tutorial use the verified path
  (`http://localhost:2000/event`). Worth a heads-up to whoever maintains
  `whatsappd`'s README, though — per the guardrails — that repo was not
  touched from here.
- Did **not** attempt real `@`-mention detection (WhatsApp's
  `contextInfo.mentionedJid`) — whatsappd's sidecar wire format doesn't
  carry it across the HTTP boundary today. Used a plain-text trigger word
  instead and documented the tradeoff rather than quietly shipping
  something that looks like real mention detection but isn't.

## Follow-ups for Aaron

1. **Set real secrets** wherever this gets deployed/run:
   `GITHUB_TOKEN` (scope it to just the repo(s) you want the bot on),
   `GITHUB_REPO`, `ANTHROPIC_API_KEY`, `WHATSAPP_SIDECAR_TOKEN` (generate
   with `openssl rand -hex 32`).
2. **Pair your own WhatsApp number** — `npm run whatsapp`, scan the QR (or
   set `WHATSAPP_PAIRING_PHONE` for a pairing code). Use a number you're
   comfortable risking; see the ban-risk section in the tutorial and
   README. No live WhatsApp session was started as part of this build, per
   the guardrails, so pairing is entirely untested against a *real* device
   — the HTTP surface it talks to (the sidecar's `/send`, `/markRead`,
   `/setTyping`, and the Eve channel's `/event`) is whatsappd's existing,
   already-tested adapter, unchanged by this project.
3. **Find and set `WHATSAPP_GROUP_ID`** after adding the bot to a group —
   the tutorial (§7) explains how to read it off the first inbound message.
4. Consider whether the default GitHub token scope (repo-wide `repo`) is
   too broad for your comfort; a fine-grained, single-repo PAT is a better
   fit for a bot that only needs to act on one repo.
5. If whatsappd's `WireMessage`/`SidecarEvent` ever grows real mention
   metadata, `agent/channels/whatsapp.ts`'s `isAddressed()` is the one
   function to update to use it instead of the text-trigger heuristic.
