# Session handoff — memory gate → Workers v1 → v1.5 (2026-08-14)

Execution state for the session that shipped the memory gate follow-through,
the Workers v1 machine, and the production memory re-read. The narrative
ledger is [`current-state.md`](./current-state.md) — this file is the
session-scoped bridge: branch state, operational facts, guardrails, and the
exact next moves. Prefer pointing here over re-deriving.

## Mission

Ambient (see root `CLAUDE.md`): durable conversational work over WhatsApp,
four fixed agent kinds. This session's arc: (1) memory ship gate — merged
by the master as **PR #24**; (2) **Workers v1** — tools are code, agents
are data; machine gate met live; **PR #25 open, awaiting the master's
merge**; (3) **production memory wipe-and-re-read — done**; (4) **Workers
v1.5 "the craft" — brief cut, PR #26 open (draft), stacked on #25**, work
not started.

## Where everything is

- Branch `workers-v1` @ `0a33c44` → PR #25 (ready). Branch `workers-craft`
  @ `a0feab9` (this file lands on top) → PR #26 (draft, base = workers-v1;
  retargets to master automatically when #25 merges).
- Worktree: `.claude/worktrees/memory-ship-gate` (session works here; the
  branch inside is what matters, not the folder name).
- Production daemon: runs from `.claude/worktrees/prod-master`
  (origin/master, currently **pre-#25**), `AMBIENT_HOME=~/.ambient`,
  started via `nohup pnpm exec tsx src/cli.ts` from that directory. It is
  RUNNING on the rebuilt ontology.
- Test rig: `.proof-private/` (symlink from the worktree). Subject =
  `android` profile — **the SAME WhatsApp account as production on linked
  devices: stop production before any rig proof.** Peer = `ios` profile.
  The Tst group id now lives in `send-allowlist.json` `groups[0]`
  (membership verified rig-only). Rig config gained the `worker` role
  (terra) and `conversation.scheduling.leaseMs: 420000`.
- Pre-wipe backup: `.proof-private/backups/ambient-prewipe-20260814T180052Z.db`
  (old ontology: 232 claims / 58 entities — fully recoverable).
- Sandbox repo: `AaronAbuUsama/ambient-worker-sandbox` (issues #1–#6 =
  adapter hardening debris; **#7, #8 = live-proof issues**).
- System map: `docs/maps/the-live-loop.html`.

## Decisions and their why (full rationale in the ledger)

- **Tools are code, agents are data; Worker is the harness, not the brain**
  — ledger § "Design revision (2026-08-14)". Master chose explicitly.
- **Speaker-direct delegation under mandate grants; global definitions +
  local grants; personal gh attribution accepted for v1** — ratified via
  three explicit answers. Machine identity arrives with the VPS.
- **MCP posture** — 2026-07-28 stateless spec verified; core effectful
  tools stay native (policy lives in the host); MCP becomes a second
  `ToolEntry` kind when a real consumer exists.
- **Idempotency is layered** — assignment id from the delegating claim;
  the retained receipt is the authority; the issue marker covers only the
  crash window. GitHub is never asked whether we already acted.
- **The six live-failure fixes** — ledger § "The machine's proof gate:
  MET". Terminal-adoption guard; send-adoption on key conflict; loud lease
  release with retry; `busy_timeout=1500`; worker claims from its poll
  (never an instant wake). Each was measured live before being fixed.
- **v1.5 brief (six settled decisions)** — ledger § "Next slice: Workers
  v1.5". Structured done/declined outcomes derived from receipts; skills
  split by ownership; routing never guessed (ask the chat); progressive
  disclosure via Pi's convention + `read_skill`; backfill dry run = answer
  key; vision directive (terra/luna already see; memory ingests images).

## Done (commit trail, oldest → newest, all pushed)

`f337465` v1 slice cut · `fdd27c3` gh capability (live-hardened) ·
`8efc067` design revision · `2b96333` scanner + grants + toolbox ·
`b6bec59` assignment surface · `49d0e38` harness/drain/wiring (+ `target`
migration 0009) · `883e3ec` speaker delegates + return path ·
`9df413a` canon + glossary · `a670f19` offline rehearsal PASS ·
`3ed9e77` live proof + terminal-adoption fix · `0020837` loud lease
release · `b81b17d` send adoption · `9df8a3f` busy_timeout + release
retry · `490713b` poll-not-wake · `c179deb` gate-met record ·
`01002ec` production re-read record · `0a33c44` live-loop map ·
`a0feab9` v1.5 brief (on workers-craft).

Proof receipts: offline rehearsal PASS first try; live PASS attempt 7
(issue #8 filed + reported in-chat, peer-observed); production re-read
golden 20/22, faithfulness 0.917, one 0.571 window = measured judge error
(all flags verbatim in their own citations — do NOT tune the judge to
make it pass). 146 unit tests; `vp check` clean.

## Held / next, in order

1. **BLOCKED on the master's three calls:** (a) merge PR #25; (b) backfill
   sandbox-first or straight to real repos; (c) the repo ceiling list for
   the real definition (candidates: the ontology's 5 repository entities).
2. After #25 merges: `git pull` in `.claude/worktrees/prod-master`, restart
   the production daemon from it (picks up send-adoption + busy_timeout —
   production-relevant fixes).
3. **Craft increment** (on workers-craft): structured outcomes →
   `bug-intake` skill + worker decline standard → progressive disclosure →
   backfill dry-run review document (this IS the answer key source; the
   ontology's 46 issues are the walk list) → `worker-*` evals → re-run
   both proofs + one live under-specified case via the Tst group.
4. Go-live for the real Bug Reports group per the brief's sequence — only
   after the master reviews the dry-run document.
5. Later, named: media/vision slice; conversation work store has no
   park-after-N (measured: 20 retries in 4 min); libsql single-flight gate
   as the deeper contention fix; Bad MAC session noise.

## How-to

- Validate: `vp check` + `vp test` (pre-commit runs check --fix; expect it
  to reformat). TypeScript standard: no `any`, `unknown` at boundaries,
  ports owned by roles.
- Proofs: `vp run proof:worker-delegation` (offline, fake gh, safe
  anywhere). `proof:worker-live` = LIVE rig: stop production first, run
  detached (`nohup … > worker-live.log`) because the harness kills
  backgrounded Bash at 10 min, watch with a Monitor on grep'd milestones
  (`⇢|⇠|←|✗|"verdict"`), and expect libsignal "Bad MAC" stderr spam —
  filter it out or it floods.
- Between failed live attempts: cancel stranded queued/running tasks via
  the repository's own `transition` (running→cancelled is legal), and
  delete the test chat's `conversation_inbox` rows — a stale first item
  poisons claim-derived idempotency keys.
- Real identifiers never enter code, logs, commits, or receipts —
  statuses, counts, lengths, issue numbers only.

## Gotchas — will bite

- **Rig subject = production account.** Never run both daemons.
- **Do NOT re-add `worker?.wake()` in the delegate provider** — it was
  removed deliberately (claim-vs-evidence-transaction collisions, three
  live failures). The poll claims within 15s.
- Send adoption means a recovered claim that already spoke can never say
  anything new — correct for retries, known limitation.
- The judge's 0.571 window is instrument error, recorded as debt — do not
  "fix" memory or judge to chase it.
- Worktree-isolated Bash refuses compound/redirect commands and git
  aimed at other checkouts — use plain commands, python heredocs for
  multi-edit, and start the prod daemon with `cd prod-master && nohup …`
  (allowed form).
- `git stash` is shared across worktrees — never bare stash.
- The master's process guardrails (in auto-memory): questions are not
  build orders — state the exact plan, wait for go; stacked PRs for
  follow-on increments; diagrams via his `diagram-design` skill as local
  HTML, never Artifacts.

## Key pointers

Ledger: `docs/status/current-state.md` (§ Workers v1 slice + design
revision + gate MET + wipe-and-re-read + v1.5 brief). Canon:
`docs/canon/architecture.md` (§ Assignments and Workers, § Worker
delegation). Glossary: `CONTEXT.md` (§ Agents and delegation). Code:
`src/worker/` (tools, contract, service, pi-agent), `src/github/issues.ts`,
`src/home/agents.ts`, `src/database/tasks.ts`, delegate provider in
`src/app/resources.ts`. PRs: #25 (machine), #26 (craft, stacked). Auto-
memory index: `~/.claude/projects/-Users-abuusama-projects-whatsapp-agent-tui/memory/MEMORY.md`.
