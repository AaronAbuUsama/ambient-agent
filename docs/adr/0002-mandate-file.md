# The mandate file: one file per chat, fail-closed, config by convention

One `mandate.yaml` per chat folder carries the whole grant. A chat is active
because its folder holds a valid mandate; a broken file means an inactive
chat, loudly. Decided on the home-litigation map
([Mandate file](https://github.com/AaronAbuUsama/ambient-agent/issues/4)),
reacting to the walking-skeleton prototype
(`prototype/walking-skeleton-home`) and superseding ADR 0001's
two-files-per-chat clause.

```yaml
# chats/bug-reports/mandate.yaml — the whole grant, one file
chatId: 120363419724078455@g.us # written by the CLI; humans don't edit it
mode: responding # omit for the default: listening
instructions: |
  Be concise. Prefer bug-report follow-ups over chit-chat.
memoryBrief: |
  Track bug reports: status, owner, evidence.
```

The minimum mandate — what activation writes — is the `chatId` line alone:
active, `listening`, standard prompt, default memory.

## The rules

1. **Config by convention.** The CLI creates chat folders and mandates; the
   operator is not expected to hand-build the tree. A folder with a readable,
   valid mandate is an active chat. No folder — nothing exists Ambient-side
   (whatsappd still mirrors every accepted message; that history is what
   memory pages back through on later activation).
2. **Schema v1**, strict — unknown or misspelled keys are validation errors:
   - `chatId` (required): the real chat id. CLI-written identity; editing it
     re-points the folder (old chat deactivates, new one activates — loud).
   - `mode` (optional, default `listening`): speaking rights only.
     `listening` is silent; `responding` speaks; `proactive` stays reserved.
   - `instructions` (optional): the per-chat override of the standard speaker
     prompt. Base role prompts stay in the package.
   - `memoryBrief` (optional): this chat's digestion focus, injected into
     memory's prompt assembly for the chat. Retires the memory-v2 prompt's
     hard-coded Bug Reports focus by design.
3. **Fail-closed.** A missing mandate, unparseable YAML, schema violation, or
   two folders claiming one `chatId` makes the chat **broken = inactive**
   until a human fixes the files. No keep-last-good, no winner-picking, no
   stale grant ever left running. Active speaker records mirror exactly the
   set of valid folders (reconcile by scan — a broken file never needs to be
   half-read to find its owner).
4. **Loud, not stored.** Brokenness is a recomputable fact about files, not
   an event: precise validation errors go to the log, and the CLI (and later
   a Root tool) re-validates the home on demand. No diagnostics table, no
   status files.
5. **Activation always starts from now.** New folder, fixed file, flip to
   `responding` — the speaker answers messages from that moment forward; the
   watermark is machine-stamped at (re)activation and never authored.
   Earlier messages are memory's territory (back-paging, history lookback),
   never fresh input — so a fixed three-day-old typo never triggers a
   backlog sweep, and a broken interval loses nothing but the responses not
   sent during it.
6. **Models never write these files raw.** Mandate writes by the Root go
   through a validating, atomic write tool (built at the Root rung), so a
   model cannot produce an invalid file. Humans may edit directly — a
   power-user stopgap; if they break it, rule 3 and rule 4 apply. The
   read-side projector remains the sole authority for what is active,
   whatever put bytes on disk.

## Considered options

- Keep-last-good (an invalid file leaves the previous projection running,
  as the prototype demoed) — rejected: it keeps a grant live that no longer
  matches disk, needs its own surfacing machinery to be honest, and solves a
  data-loss problem that does not exist — the mirror plus default-on
  back-paging memory make a broken interval fully recoverable.
- Two files per chat (`chat.yaml` binding + `mandate.yaml`, ADR 0001) —
  superseded: the split existed so a broken mandate could not orphan the
  binding that keyed the kept row. Fail-closed keeps no row, so there is
  nothing to orphan; reconcile-by-scan identifies deactivations without
  reading broken files. One file, id inside.
- Authored `activationPoint` (the strawman field) — rejected: the watermark
  is a runtime record of the activation moment, not policy; a living file
  re-asserting an old pin on every projection is a footgun.
- Durable diagnostics record / per-chat status file — rejected: built for a
  Root consumer that does not exist yet; brokenness is recomputable from
  disk on demand.

## Consequences

- ADR 0001 is amended in place: one `mandate.yaml` per chat folder;
  `chat.yaml` and the "binding file" noun are retired.
- `conversation.speakers` stanzas (`src/app/config.ts`) retire into mandate
  files at the migration rung.
- Ingestion's unconditional inbox enqueue moves behind the active-chat gate
  at the migration rung ("no inbox when the chat is not active" is the
  product rule; today's claim-time gate approximates it).
- The CLI is the operator surface for seeing brokenness and activating or
  editing chats — its shape is deliberately undecided here.
