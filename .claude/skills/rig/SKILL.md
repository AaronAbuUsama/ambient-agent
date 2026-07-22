---
name: rig
description: Build, deploy, and live-prove the coworker on the rig (capxul-vps). Use for any change that must be proven end-to-end (WhatsApp → Brain → GitHub with correlated receipts), for deploys, and for rollout ops — adding groups, adding repos, ChatGPT subscription auth, model switches. Supersedes the old verify skill.
---

# The rig — build, deploy, prove, operate

The product is **the coworker** ([docs/SYSTEM-ARCHITECTURE.md](../../../docs/SYSTEM-ARCHITECTURE.md)):
one silent **Brain**, dumb per-Surface **Speakers**, one global **Scribe**, one append-only
**Graph** (Attestations → Belief Projection). Execution authority is issue **#299** on
`integration/coworker-replacement`; §13 of SYSTEM-ARCHITECTURE and STATUS.md are the honest
built-vs-designed map. Unit tests green ≠ done. **A nonce-tagged live scenario with
correlated receipts is the only "done."**

## The rig map

| Thing | Where |
|---|---|
| Live runtime | ssh `capxul-vps` (srv1626161) — systemd **`ambient-agent.service`**, port **3737** |
| Install | `~/.local/npm-global/lib/node_modules/ambient-agent` (global npm, from tgz) |
| Data dir | `~/.ambient-agent/` — `application.sqlite`, `flue.sqlite`, `credentials/`, `whatsapp/`, `logs/`, `workspaces/` |
| Config | `~/.ambient-agent/config.json` — managedChats, model profiles, github repos, port, sandbox |
| GitHub identities | `credentials/github-{coder,planner,reviewer}.json` — three GitHub Apps; Planner is the runtime's own identity + webhook secret |
| Model auth | `credentials/model-api-key.json` (api-key mode) or ChatGPT oauth credential (subscription mode, provider `openai-codex`) |
| Test group | WhatsApp `Tst` group `120363410063306573@g.us` — the only managed chat until rollout |
| Test driver | **Independent regular-user WhatsApp account** in Chrome at web.whatsapp.com (drive via `mcp__claude-in-chrome__*`). Never send proof messages from the agent's own account |
| GitHub | `gh` against `AaronAbuUsama/ambient-agent`; work targets `integration/coworker-replacement` |
| Dead rig (do not use) | `code-factory` box: `validate-88/`, tmux `ambient`, port 42069 — the pre-replacement runtime, failed state, historical only |

**Before anything else, enumerate the live runtime**: `ssh capxul-vps 'systemctl status
ambient-agent --no-pager | head -4; curl -s localhost:3737/health'` → expect `ok:true,
runtime.state:"healthy", whatsapp.phase:"online"`. A 3.3-hour "blocked" was once burned on
a dead *local* session copy while this service sat healthy. Local state is never the
deployment boundary.

**The WhatsApp session store is single-home.** Never copy `whatsapp/` into another
install — the copy triggers companion revocation and `logged_out` is terminal and
store-destroying. If the paired host is alive, deploy to it; only a QR re-pair from
Aaron's phone can resurrect a dead session.

## Build → deploy

From the repo on the branch under test (normally `integration/coworker-replacement`),
deploy only **merged, CI-green** commits:

```bash
pnpm install && pnpm run typecheck && pnpm test && pnpm run build:runtime
npm pack   # → ambient-agent-<v>.tgz; rename with the short SHA
scp ambient-agent-<v>-<sha>.tgz capxul-vps:~/
ssh capxul-vps 'set -e; TS=$(date +%Y%m%dT%H%M%SZ); \
  cp ~/.ambient-agent/application.sqlite ~/backups/application-$TS.sqlite; \
  cp ~/.ambient-agent/flue.sqlite ~/backups/flue-$TS.sqlite; \
  tar -C ~/.ambient-agent -czf ~/backups/whatsapp-$TS.tgz whatsapp; \
  npm i -g ~/ambient-agent-<v>-<sha>.tgz --prefix ~/.local/npm-global && \
  sudo systemctl restart ambient-agent'
ssh capxul-vps 'sleep 5; curl -s localhost:3737/health'
```

Then record **exactly which tree is live**: integration commit, source commit,
`sha256sum ~/.local/npm-global/lib/node_modules/ambient-agent/dist/server.mjs` — and keep
the previous tgz as rollback. Record the deployed revision *before* overwriting anything
shared; an unrecorded baseline is unrecoverable forever. A proof that doesn't name its
deployed hash is not a proof. `ambient-agent smoke` runs the live battery; `status` /
`doctor` diagnose a sick install.

## Live proof discipline (the working template)

Every claim of runtime behaviour gets one **scenario nonce** (`TST-<slice>-<sha7>-R<n>`):

1. **Baseline absence**: query `application.sqlite` proving the nonce appears nowhere.
2. Drive from the regular-user account in the Tst group, nonce in the message text.
3. Correlate across every layer touched: provider message ID ↔ Conversation Archive event
   ↔ Intent / Brain Batch / Brain Effect / Surface Delivery / Scribe Batch / Attestations /
   work records ↔ GitHub URLs + author identity (`ambient-planner[bot]`,
   `ambient-coder[bot]` — never a human login) ↔ WhatsApp-visible outcome.
4. **Restart proof** when the diff touches durability: `sudo systemctl restart
   ambient-agent`, re-run the receipt query, require **byte-identical** counts/IDs
   (hash the output before and after).
5. State the **honest boundary**: exactly what this tip proves and deliberately does not.
   Keep the statuses separate: *mechanically green* / *runtime-proven* / *human-only*.
   **Configuration is never proof** — a dashboard or view counts only when real events
   from the deployed head have flowed through it. A PR with any blocked mandatory proof
   layer is a **draft**, never "ready". A branch must not author or modify the gates that
   approve it.

### Scenario library (the #299 loops)

- **Conversation:** nonce request → exactly one Intent admitted → one Brain Batch →
  directive or *deliberate* silence → Speaker stays responsive to a second message
  mid-decision → GitHub untouched on incomplete requests → restart loses nothing.
- **Knowledge:** related nonce facts via two chats → one global chronological Scribe batch →
  every claim links immutable evidence → replay produces same meaning, no duplicate claims,
  no confidence inflation.
- **Work:** nonce work request → one Brain-owned work identity → one Bounded Workflow →
  one real GitHub artifact → terminal result survives restart → Brain picks the reporting
  chat → WhatsApp reports the real GitHub URL.

## Rollout ops (all via the CLI on the VPS)

```bash
ssh capxul-vps
ambient-agent status                             # readiness
ambient-agent auth                               # ChatGPT device-code flow → subscription credential (Aaron approves in browser)
ambient-agent config --model-provider openai-codex --model <id>   # switch to subscription models (per-role: --model-speaker etc.)
ambient-agent config --chat <jid>                # ADD a managed chat (accumulates; selected becomes primary)
ambient-agent config --repository owner/name     # ADD an allowed repo (accumulates, verifies App access)
ambient-agent config --canary-chat <jid>         # dedicated smoke-canary group
sudo systemctl restart ambient-agent             # config changes need a restart (#179)
```

Gotchas that have already burned us:

- **Never run `config` (or any WhatsApp-touching CLI command) while the service is
  running** (#311): it opens a second client on the live session store — the server kicks
  the service's stream (`conflict: replaced`) and a crash can destroy `whatsapp/` on disk.
  `systemctl stop ambient-agent` → config → `start`. Model/repo-only flags are safe
  non-interactively, but stopping first costs one minute and risks nothing.
- Do not trust `/health` while diagnosing WhatsApp: it can report `online` after the
  stream is dead (#312). Check `ss -tnp` for the process's TCP connections or the journal.
- The agent's WhatsApp account must already be a **member** of a group before
  `config --chat` can select it (it must appear in the account's synchronized chats).
- Adding a repo requires the three GitHub Apps to be **installed on that repo** first —
  `config --repository` verifies Planner access and fails honestly.
- ChatGPT oauth tokens are **never refreshed after boot** (#248) — after an auth, restart;
  a dead model provider can hide behind a healthy-looking runtime. Check `logs/`.
- Non-interactive `config` requires a valid WhatsApp session; `logged_out` means an
  interactive QR re-pair from Aaron's phone — nothing else works.

## Hard rules (paid for in ~3 billion tokens)

1. **Check the live target first, then say blocked if blocked.** No gating proof = no
   forward motion; hours of code without the live test is regression, not progress. But
   before declaring blocked, enumerate the real hosts — and when a proof command fails,
   diagnose the command itself (wrapper bug vs environment) before declaring an
   environmental blocker.
2. **One construction PR = one narrow claim + its proof.** State what this tip proves and
   what it deliberately does not. Cut every branch from the PR's actual target base.
3. **Scenario evidence only.** "Unit and integration tests are important but they are not
   proof it works. A scenario is proof — with evidence from the database and GitHub."
4. **Drive as a user.** Proof messages come from the independent regular-user account in
   the authorized Tst group — never internals, never inserted rows, never the agent's own
   account.
5. **Ratify the premise before fanning out.** Fifteen parallel lanes once finished
   building multi-tenancy the day it was killed. One cheap "does this survive contact
   with Aaron?" gate beats any amount of parallel execution.
6. **Cap review cycles at 2 and review the diff, not the biography.** Full-context
   reviewer forks re-replaying 100M+ tokens per micro-commit were the single dominant
   token sink. Reviewers get the diff + the spec, cold. Two clean verdicts end the loop.
7. **Plan in provable slices, not decision topics.** 12h of decision tickets were
   superseded; 6h of proof-per-PR rungs shipped a live system. If a planning frontier
   grows as it's consumed, collapse it into one execution issue with proof gates
   (#299 is the template). Never run two grilling campaigns on one human in parallel;
   a string of "agreed" at 3am is a warning sign, not consent.
8. **Never invent a noun.** A new domain term requires a code path that already branches
   on it ("Brain-opened DM Surface", "Work Item", `open_surface` each cost a correction
   cycle).
9. **Decisions land on the branch immediately or they don't exist**; the codebase — not a
   web artifact, an issue thread, or memory — is the source of truth.
10. **Timebox silent autonomy.** Emit a sitrep (messages sent / receipts / PRs) on a fixed
    interval; cap any unattended turn at ~45 min with a veto-able checkpoint; watch the
    model-quota meter and stop spawning at 60%.
