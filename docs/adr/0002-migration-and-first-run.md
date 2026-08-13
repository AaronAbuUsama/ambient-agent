# Migration and first run: one env var, a boot ensure-step, a checklist

ADR 0001 fixed the home layout; this decides how the process finds the home,
how a home comes to exist on a fresh machine, and how today's `./data` and
`ambient.config.json` move in. Decided on the home-litigation map
([Migration](https://github.com/AaronAbuUsama/ambient-agent/issues/7)).
Population fact that shaped everything: one production deployment plus the
rig's `android` profile, on an unreleased product — the old layout will never
exist anywhere else.

## Decisions

1. **The home is located by `AMBIENT_HOME` alone** (default `~/.ambient`).
   Every path inside is fixed by ADR 0001, so `AMBIENT_CONFIG`,
   `WHATSAPP_DATA_DIR`, and `AMBIENT_DATABASE_URL` are retired and the
   `database.url` and `whatsapp.dataDirectory` config keys die with them —
   one knob relocates the whole home atomically; nothing can tear the layout
   apart. Environment stays: the home path, secret values, `WA_LOG_LEVEL`.
   The rig sets `AMBIENT_HOME=.proof-private/android` instead of rebasing
   paths in `rigConfig()`.

2. **First run is a boot ensure-step, not an `init` command.** Every start
   runs an idempotent ensure: create `chats/`, `skills/`, `state/`; seed
   `README.md` and a fully commented `config.yaml` template only if absent.
   Then configuration validation fails closed, naming the file to edit. The
   ensure-step self-heals deleted directories on the next boot. ADR 0001's
   "init seeds README.md + config.yaml" names this boot phase, not a
   subcommand — there is no CLI, and an unedited template cannot run anyway,
   so seed-and-stop gives the stranger the shortest path.

3. **The migration is a checklist, not code.** Migration code for a
   population of one runs a handful of times and rots; startup auto-detection
   would additionally risk firing during a rig proof run and moving
   production data into the wrong home. The checklist below executes in the
   same sitting as the ladder rung that ships the new paths — the move can
   only happen once code reads the new locations.

4. **`config.yaml` keeps deployment, sheds policy.** JSON → YAML
   transliteration, same key shapes (the `models:` nesting stays; flattening
   is cosmetic churn):

   | key                                | fate                                                                  |
   | ---------------------------------- | --------------------------------------------------------------------- |
   | `models.providers`, `models.roles` | stays                                                                 |
   | `whatsapp.accountId`               | stays                                                                 |
   | `whatsapp.historyBackfillLimit`    | stays                                                                 |
   | `conversation.outboundMode`        | stays (deployment safety rail)                                        |
   | `conversation.scheduling.*`        | stays                                                                 |
   | `logging.level`                    | stays                                                                 |
   | `database.url`                     | dies — fixed `state/ambient.db`                                       |
   | `whatsapp.dataDirectory`           | dies — fixed inside `state/`                                          |
   | `conversation.enabled`             | dies — no mandates means off; a config kill-switch is parallel policy |
   | `conversation.instructions`        | dies — mandates carry instructions                                    |
   | `conversation.speakers`            | leaves — becomes `chats/<slug>/mandate.yaml`                          |

5. **The one existing speaker's folder is hand-written, its row untouched.**
   The production database holds exactly one speaker record (a listening
   group chat); the checklist writes its `chat.yaml` (the chat id) and
   `mandate.yaml` (`mode: listening`) by hand, minting the slug at execution
   time. The activation watermark stays in the row — mandates never carry
   watermarks. Migration's contract: it leaves mandate ≡ speaker record so
   the first boot's reconcile is a no-op. What happens when file and row
   _disagree_ is the mandate-file and speaker-record tickets' design, not
   migration's.

6. **The repo stops shipping deployment config.** `git rm
ambient.config.json`; the home's own git (the git-home decision) versions
   `config.yaml` from now on, so the provider catalog stays versioned without
   a drift-prone committed example. The `.gitignore` `data` line drops once
   `./data` is gone. The rig's `ios` profile needs no home — the peer API
   takes an explicit directory and is untouched.

## The checklist

Executed by the operator when the rung that reads the new paths deploys:

1. Stop the daemon.
2. `tar -czf ~/ambient-premigration.tgz data/` — safety net for the
   irreplaceable `whatsapp.db` (auth; losing it costs a QR re-pair).
3. `mkdir -p ~/.ambient/state && mv data/* ~/.ambient/state/`
   (same-volume rename; `whatsapp.db-wal`/`-shm` move with it if present).
4. Hand-write `~/.ambient/config.yaml` from `ambient.config.json` per the
   disposition table.
5. Hand-write `~/.ambient/chats/<slug>/chat.yaml` + `mandate.yaml` for the
   one speaker row.
6. `git rm ambient.config.json`; start; verify a healthy boot and WhatsApp
   session; delete the tarball.

Repeat 1–5 for `.proof-private/android` (its own home; proofs export
`AMBIENT_HOME`).

## Considered options

- An `ambient migrate` command or startup auto-migration — rejected: code
  for two executions ever, carrying partial-failure handling and (for
  auto-detection) a real wrong-home hazard when proofs run from the repo
  root with `AMBIENT_HOME` set.
- An explicit `ambient init` subcommand — rejected: needs CLI machinery that
  doesn't exist and adds a step to the stranger's path; the ensure-step
  reaches the same seeded state with zero new surface.
- A committed `config.example.yaml` — rejected: a second copy of the seed
  template that drifts; the home's git already versions the real document.
- Keeping `conversation.enabled` / `conversation.instructions` — rejected:
  after mandates they are parallel policy representations that must agree
  with the policy plane.

## Consequences

- `loadAppConfig` shrinks: resolve `AMBIENT_HOME`, read `<home>/config.yaml`
  (YAML parse), no path arithmetic from config keys; the seed path
  `speakers.seed(config.conversation.speakers)` dies with the stanza.
- Proofs and the rig select a home with one env var; `rigConfig()` keeps
  only the model-pool fallback.
- A stranger's first contact is: run, read the seeded README + commented
  template, edit, run — no wizard, no second command.
- The packaging ticket (#8) inherits a repo with no deployment document and
  a first-run that needs only the binary.
