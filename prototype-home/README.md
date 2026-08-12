# PROTOTYPE — walking-skeleton home (throwaway)

**The question** ([Prototype: walking-skeleton home](https://github.com/AaronAbuUsama/ambient-agent/issues/12)):
how much of the `~/.ambient` home really works in the filesystem today —
pi's skill loading across home + chat scopes, its diagnostics on malformed
files, a mandate parse→validate→project round trip, and `fs.watch` against
editor atomic saves?

**Shape assumption:** the /prototype logic branch prescribes a single HTML
demo, but this question is about real Node APIs (the actual pi loader, real
`fs.watch`) an HTML file would have to fake — so it's Node scripts over a
fake home tree instead. Same spirit: full state printed after every step,
pokeable by hand.

Everything here is throwaway. `home/` is a fake `~/.ambient` per the
brainstorm sketch; all chat ids are fake. The mandate schema is a strawman —
the real one is the mandate-file ticket's decision.

## Run it

```sh
./node_modules/.bin/tsx prototype-home/probe-skills.ts    # loader, precedence, diagnostics
./node_modules/.bin/tsx prototype-home/probe-mandate.ts   # parse -> validate -> project
./node_modules/.bin/tsx prototype-home/probe-watch.ts     # then edit+save tst/mandate.yaml in your editor
```

Things to poke: edit `home/chats/tst/skills/shared-recall/SKILL.md`, break a
frontmatter line, add your own skill dir, re-run probe-skills. Change
`mode:` in a mandate and re-run probe-mandate. With probe-watch running,
save the mandate from your editor a few times and watch which watcher stays
alive.

## Findings (recorded 2026-08-12, all probes run live)

### probe-skills — the pi loader across home + two chat scopes

- **Multi-location loading works today.** One `loadSkills` call over
  `[home/skills, chats/tst/skills, chats/product-feedback/skills]` returned
  all five valid skills.
- **No dedup/precedence in pi, confirmed live:** both `shared-recall`
  copies came back, ordered by input-directory order. Collision policy is
  entirely ours — a ~20-line chat-wins fold (`applyPrecedence` in
  probe-skills.ts) produced the correct 3-skill assembly for `tst` with a
  shadow warning. That function is the liftable seed for the Skills ticket.
- **`loadSourcedSkills` provenance is exactly the two-scope shape we want:**
  `{scope:"home"} | {scope:"chat", slug}` attached verbatim to every skill
  _and_ every diagnostic.
- **Malformed SKILL.md degrades gracefully:** three precise
  `invalid_metadata` diagnostics for one broken file (missing description,
  name/dir mismatch, charset violation); the file is skipped, everything
  else loads. No crash. Matches the "bad write degrades one skill, never
  bricks the agent" requirement.
- **Gotcha for the layout ticket:** a stray `skills/README.md` produces an
  `invalid_metadata` diagnostic on _every_ load (root `.md` files are
  treated as skill candidates). Layout should keep prose files out of
  skill roots or expect the noise.

### probe-mandate — parse → validate → project

- Valid mandate (`tst`): YAML → zod → projected speaker row
  (`conversationId` from the `chat.yaml` binding, `mode`, `instructions`,
  `activationPoint` → `attendFrom`). Clean.
- Invalid mandate (`product-feedback`, `mode: shouting`): one precise zod
  diagnostic (`mode: Invalid option: expected one of
"listening"|"responding"`), nothing projected, yesterday's row retained —
  a live demo of **keep-last-good**; keep-last-good vs fail-closed stays
  the mandate-file ticket's fork.
- `memoryBrief` parses fine but has no projection target — it feeds run
  assembly, not the row.

### probe-watch — fs.watch vs atomic saves (simulated write-tmp + rename)

- **Reproduced the research exactly:** the per-FILE watcher fired once on
  the first atomic save, then went permanently silent — the second atomic
  save and a later in-place write produced _nothing_ from it. The
  DIRECTORY watcher (recursive) fired through all three.
- `eventType` was `rename` even for an in-place append — meaningless
  dirty bit, as the research said.
- The 200ms debounce coalesced each burst (2–3 raw events) into one wake
  hint. Watch directories, never files; rescan on hint.

## Poke round (2026-08-12, run by the agent — real editors, mutations)

### probe-watch against real save strategies

- **Real nvim (headless), save #1:** nvim's save dance is a probe file
  (`4913`), a backup (`mandate.yaml~`), and multiple renames — 7 raw events
  on the directory watcher. The per-FILE watcher fired exactly once, and
  for the _backup_ file, not the target — then died.
- **nvim save #2:** FILE watcher totally silent. Directory watcher fine.
- **`sed -i`:** temp file (`.!15611!mandate.yaml`) + rename; FILE watcher
  silent, directory watcher fine.
- **Folder rename `tst` → `tst-renamed` → `tst`** (the slug-rename
  scenario): the recursive directory watcher saw both legs — a slug rename
  is just another wake hint; the rescan reconciles bindings.
- Net: identical to the research and the simulation, now confirmed with a
  real editor. Watch directories, never files.

### Mutation pokes

- **Mode flip** (`responding` → `listening`): next projection pass emitted
  the updated row. Edit-then-next-claim hot-reload semantics hold.
- **Broken chat-scoped skill** (unclosed frontmatter fence in tst's
  `shared-recall`): one diagnostic with the right path (message reads
  "description is required" — indirect but locatable), the chat copy is
  skipped, and the assembly **fell back to the home copy** — no shadow, no
  lost capability. A Root typo in a chat skill degrades to the home
  version, which is exactly the failure shape we want.
- **New skill dir added mid-poke** (`standup-summary`): picked up on the
  next load, no restart, no registry.
- Tree restored to its designed state afterwards; baseline probe re-run
  green (3 skills for tst, chat copy shadowing again).

## Verdict sketch (to confirm at resolution)

The home's policy plane works in the filesystem _today_ with zero new
infrastructure: pi loads multi-scope skills with provenance and safe
diagnostics; the mandate round trip is ~40 lines of yaml+zod; directory
watching is a sound wake hint. The pieces Ambient must own are exactly two:
skill collision policy (chat wins) and mandate bad-file policy (the
keep-last-good vs fail-closed fork).
