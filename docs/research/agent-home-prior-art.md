# Prior art for agent homes and the Agent Skills standard

Research for issue #14. Question: what home-directory conventions should
`~/.ambient` copy or deliberately break?

Sources: Claude Code official docs plus the observed `~/.claude` layout on a
real machine; the Agent Skills specification and client-implementation guide at
agentskills.io; Codex CLI (`~/.codex`) docs; and the actual
`@earendil-works/pi-agent-core@0.84.1` skill loader this repo already depends
on. Evidence with links follows the summary.

## Answer first

**Copy** the Agent Skills `SKILL.md` contract verbatim, the
concatenate-don't-override model for layered instruction files, and lenient
load-with-diagnostics for anything an agent or user may have written by hand.
**Break** Claude Code's multi-tier precedence matrix, its inconsistent
precedence directions, and the near-universal habit of mixing hand-edited
files with machine state at the top of the home directory. `~/.ambient` needs
exactly two scopes — home and per-chat, chat wins — and one machine-owned
subdirectory for everything a human should never touch.

### Conventions to copy

1. **The Agent Skills `SKILL.md` contract, exactly as specified.**
   Directory-per-skill, `SKILL.md` with YAML frontmatter, `name` (≤64 chars,
   `a-z0-9-`, must match the parent directory) and `description` (≤1024
   chars) required, everything else optional, body loaded only on activation.
   Reason: it is a published standard with an ecosystem, and pi-agent-core's
   loader already enforces precisely these limits (64/1024, the same
   hyphen/dir-match rules). Compliance costs nothing; divergence orphans us.

2. **Progressive disclosure as the loading model.** Catalog
   (name+description, ~100 tokens/skill) at startup; full body on activation;
   bundled `scripts/`/`references/`/`assets/` read only when the body points
   at them. Every studied client does this; the spec recommends `SKILL.md`
   under 500 lines with detail split into referenced files.

3. **Concatenate, don't override, for instruction/policy files.** Claude Code
   loads `CLAUDE.md` from broadest scope to nearest and concatenates — nearer
   content appears later in context, so it wins by recency, without any merge
   machinery. Codex does the same for `AGENTS.md` (root-down, "closer files
   override earlier guidance because they appear later"). For Ambient:
   global standing instructions load first, the chat's `policy.md` loads
   last. No override semantics to explain to a non-developer — later text
   simply refines earlier text.

4. **One consistent precedence direction: nearest/most-specific scope wins.**
   The agentskills.io client guide calls project-over-user "the universal
   convention across existing implementations". For Ambient: a chat-scoped
   skill shadows a home skill of the same name, with a logged warning.

5. **Lenient loading with surfaced diagnostics, never a crash.** Both the
   agentskills.io guide ("warn on issues but still load the skill when
   possible") and pi-agent-core (warnings only, malformed file → skill
   skipped, loading continues) agree. This is existential for Ambient: the
   Root agent authors these files, so a bad write must degrade one skill, not
   brick the agent. Diagnostics must be observable (log/agenda), not
   swallowed.

6. **Provenance as an application concern, tagged at load time.**
   pi-agent-core's `loadSourcedSkills` attaches an app-defined `source` value
   to every skill and diagnostic and explicitly does not interpret it.
   Ambient should define its provenance shape (e.g.
   `{ scope: "home" | "chat", chatId? }`) and pass scoped directories through
   this API rather than inventing a parallel registry.

7. **Plain hand-editable files as the interface, for humans and the agent
   alike.** Claude Code's auto memory is the proof this works both ways:
   Claude writes `MEMORY.md` + topic files, the user may edit or delete them
   at any time, one representation, no sync. Ambient's Root should edit the
   same canonical markdown/yaml files the user edits — never a shadow copy.

8. **Single validated config document.** Codex's `config.toml` and this
   repo's own configuration policy agree: one file, parsed and validated once
   at the boundary, env vars only for secrets and the config path.

### Conventions to break

1. **The multi-tier precedence matrix.** Claude Code's settings resolve
   through managed > CLI > local > project > user, with permission rules
   merging instead of overriding, plus `settings.local.json` variants,
   `CLAUDE.local.md`, and `--setting-sources`. That complexity exists because
   Claude Code serves teams, enterprises, and per-machine differences.
   Ambient has one operator and one agent: two scopes (home, chat), no
   `.local` variants, no managed tier, no override files.

2. **Inconsistent precedence directions.** Claude Code's settings go
   local > project > user, but its _skills_ go enterprise > personal >
   project — the opposite direction, documented as a surprise ("with a
   `deploy` skill in both `~/.claude/skills/` and your project's
   `.claude/skills/`, `/deploy` runs the personal one"). Pick one direction
   (chat wins) and apply it to skills and policy alike.

3. **Mixing human files with machine state at the top level.** Observed
   `~/.claude` has ~40 top-level entries: `CLAUDE.md` and `settings.json`
   sit beside `daemon.lock`, `statsig/`, `todos/`, `shell-snapshots/`,
   `file-history/`, `paste-cache/`. Observed `~/.codex` is worse:
   `config.toml` beside `auth.json`, three sqlite WAL sets, `sessions/`,
   `logs/`. A non-developer cannot tell what is safe to touch. Break it:
   everything machine-owned (db, run state, caches, locks) lives under one
   subdirectory (e.g. `~/.ambient/state/`); everything outside it is
   editable and backup-safe by construction. This is also how the two never
   clobber each other: humans and the Root co-author the policy/skill files,
   the runtime alone writes `state/`, and durable truth never lives in
   markdown.

4. **Two mechanisms for one job.** Claude Code carries `.claude/commands/`
   as a legacy alongside skills ("custom commands have been merged into
   skills"), plus reserved names for synced skills, plugin namespaces, and
   directory-qualified nested names. Ambient ships skills only, one
   collision rule, one sentence of documentation.

5. **Override-file mechanisms.** Codex's `AGENTS.override.md`-then-
   `AGENTS.md` fallback at every level is machinery Ambient doesn't need
   with only two layers and concatenation semantics.

6. **Eager loading of everything.** Claude Code's `CLAUDE.md` files load in
   full at launch and the docs repeatedly warn about context cost (200-line
   guidance, `claudeMdExcludes`, path-scoped rules as escape hatches).
   Ambient should keep per-chat policy files small and lean on skill
   progressive disclosure instead of growing a monolithic instruction file.

### Sketch of the resulting `~/.ambient`

```
~/.ambient/
  config.yaml               # hand-edited; validated once at the boundary
  skills/<name>/SKILL.md    # home-scoped skills; user- or Root-authored
  chats/<chat-id>/
    policy.md               # per-chat standing instructions; loads after global
    skills/<name>/SKILL.md  # chat-scoped skills; shadow home skills by name
  state/                    # machine-owned only: db, runs, caches, locks
```

Load rule, in one line each: instructions concatenate global→chat; skills
merge with chat shadowing home (warn on shadow); `state/` is never read as
configuration.

## Focus-question answers

**1. How do the studied products express multi-location hierarchies, and what
precedence?** Claude Code: fixed scope list (managed / user / project /
local) with explicit priority for settings, concatenation for `CLAUDE.md`,
and a _different_ explicit priority for skills; nested discovery is lazy
(subdirectory skills/memory load when files there are touched). Codex:
directory-walk from git root to cwd, pure concatenation, positional
precedence, 32 KiB cap. Agent Skills standard: silent on location and
precedence — the client guide recommends project-over-user (nearest wins) as
the de facto convention. Nobody uses nearest-wins _overriding_ for
instruction files; they use nearest-_last_ concatenation.

**2. What do users hand-edit vs what tools own?** Hand-edited in `~/.claude`:
`CLAUDE.md`, `settings.json`, `skills/`, `agents/`, `commands/`, `hooks/`,
`rules/`. Tool-owned: `projects/` (including auto memory), `todos/`,
`sessions/`, `statsig/`, `shell-snapshots/`, daemon files, caches. The
separation is by convention only — both kinds share one directory, and
nothing marks which is which. Clobbering is avoided not by locking but by
single-representation design: auto memory is plain markdown the user may
edit, `settings.local.json` is auto-gitignored, and the tool edits the same
files the user does. Codex: `config.toml` and `AGENTS.md` hand-edited;
`auth.json`, sqlite state, `sessions/`, `history.jsonl` tool-owned, same
shared-directory problem.

**3. What does the Agent Skills standard mandate vs leave open?** Mandates:
directory containing `SKILL.md`; frontmatter with required `name` (1–64
chars, lowercase `a-z0-9-`, no leading/trailing/double hyphen, must match
parent directory) and `description` (1–1024 chars, non-empty); optional
`license`, `compatibility` (≤500 chars), `metadata` (string→string map),
`allowed-tools` (experimental). Body: unrestricted markdown. Leaves open:
where skills live, discovery, precedence, activation mechanism, tool
execution, trust policy. `scripts/`/`references/`/`assets/` are recommended
conventions, not requirements. Progressive disclosure is a structural
recommendation with token budgets, not a conformance rule.

**4. What does pi-agent-core's loader support today?** See the evidence
section below — short version: multi-directory input with silent skip of
missing dirs, recursive discovery where a `SKILL.md` claims its whole
directory (nested skills below it are not loaded), root-level `.md` files as
skills, ignore-file support, symlink following, warning-only diagnostics
with five stable codes, spec-matching validation (64/1024, dir-name match),
`disable-model-invocation`, and app-defined provenance tagging via
`loadSourcedSkills`. No precedence or dedup — collisions are the
application's job, which fits Ambient defining chat-shadows-home itself.

## Evidence

### Claude Code (`~/.claude`)

Docs: [settings](https://code.claude.com/docs/en/settings),
[memory](https://code.claude.com/docs/en/memory),
[skills](https://code.claude.com/docs/en/skills).

- Settings precedence (exact, from the settings doc): managed (highest) →
  command-line arguments → local (`.claude/settings.local.json`) → project
  (`.claude/settings.json`) → user (`~/.claude/settings.json`). Permission
  rules merge across scopes rather than override.
  `settings.local.json` is auto-added to git excludes when Claude Code saves
  to it.
- `CLAUDE.md` scopes: managed policy file → `~/.claude/CLAUDE.md` →
  `./CLAUDE.md` or `./.claude/CLAUDE.md` → `./CLAUDE.local.md`. "All
  discovered files are concatenated into context rather than overriding each
  other", ordered filesystem-root-down, `CLAUDE.local.md` appended after
  `CLAUDE.md` at each level. Subdirectory `CLAUDE.md` files load lazily when
  files there are read. `@path` imports, max depth 4; external imports
  require one-time approval in project scope but not user scope.
  `~/.claude/rules/` (user) loads before `.claude/rules/` (project), "giving
  project rules higher priority" — path-scoped rules load on file match.
- Skills locations: enterprise (managed), `~/.claude/skills/` (personal),
  `.claude/skills/` (project), plugin `skills/`. Collision rule (exact):
  "Across levels, enterprise overrides personal, and personal overrides
  project." — note the direction is the _opposite_ of settings precedence.
  Plugins are namespaced (`plugin:skill`) so they cannot collide. Nested
  `.claude/skills/` below cwd load lazily on first file touch in that
  subtree and get directory-qualified names (`apps/web:deploy`) when names
  clash — both stay available. Skill directories are watched; edits hot-
  reload within a session. Symlinked skill entries are followed and deduped
  by canonical target. The `synced` folder name is reserved (claude.ai skill
  sync target). Project-skill `allowed-tools` takes effect only after the
  workspace trust dialog.
- Auto memory: `~/.claude/projects/<project>/memory/MEMORY.md` index (first
  200 lines / 25 KB loaded each session) plus topic files read on demand —
  tool-written, explicitly user-editable plain markdown, excluded from the
  retention sweep that deletes old transcripts.
- Observed layout on this machine (structure only): ~40 top-level entries
  mixing the hand-edited set (`CLAUDE.md`, `settings.json`, `skills/`,
  `agents/`, `commands/`, `hooks/`, `rules/`) with tool state (`projects/`,
  `sessions/`, `todos/`, `statsig/`, `shell-snapshots/`, `file-history/`,
  `paste-cache/`, `daemon.*`, caches). Notably, nearly every entry in
  `~/.claude/skills/` is a symlink into `~/.agents/skills/` — the
  cross-client `.agents/skills/` convention in live use.

### Agent Skills standard (agentskills.io)

Docs: [specification](https://agentskills.io/specification),
[adding skills support](https://agentskills.io/client-implementation/adding-skills-support.md).

- Frontmatter contract as summarized in focus-question 3 above; `name` must
  match the parent directory name; body has "no format restrictions".
- Progressive disclosure tiers with budgets: metadata ~100 tokens at
  startup; instructions <5000 tokens recommended on activation; resources as
  needed. "Keep your main SKILL.md under 500 lines." File references
  relative to the skill root, "one level deep".
- Location is explicitly out of scope: "the Agent Skills specification does
  not mandate where skill directories live (it only defines what goes inside
  them)". The client guide recommends scanning a client-native directory
  plus the `.agents/skills/` convention at project and user scope.
- Precedence guidance: "The universal convention across existing
  implementations: project-level skills override user-level skills." Within
  a scope, first-found or last-found, "pick one and be consistent. Log a
  warning when a collision occurs."
- Lenient validation: warn-and-load for name/dir mismatch or overlong
  names; skip-with-log when description is missing or YAML is unparseable.
- Trust: gate project-level skills on a trust check so untrusted repos
  cannot silently inject instructions. Hide disabled/denied skills from the
  catalog entirely. Don't eagerly read bundled resources. Protect activated
  skill content from context compaction.
- Reference validator: `skills-ref validate ./my-skill`.

### Codex CLI (`~/.codex`)

Docs: [AGENTS.md guide](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
(redirect target of developers.openai.com/codex/guides/agents-md).

- Global scope: `~/.codex/AGENTS.override.md` first, else `~/.codex/AGENTS.md`
  — only the first non-empty file loads. Project scope: traverse git root
  down to cwd, at each level `AGENTS.override.md`, then `AGENTS.md`, then
  `project_doc_fallback_filenames`. "Codex concatenates files from the root
  down… Files closer to your current directory override earlier guidance
  because they appear later in the combined prompt." Combined cap:
  `project_doc_max_bytes` (32 KiB default). `CODEX_HOME` relocates the home.
- Observed `~/.codex` (structure only): hand-edited `config.toml` and
  `AGENTS.md` sit beside tool-owned `auth.json`, `sessions/`, `history.jsonl`,
  `logs/`, and multiple sqlite databases with WAL files — the same
  human/machine mixing as `~/.claude`, with live database files at the top
  level.

### pi-agent-core@0.84.1 skill loader (local evidence)

Files:
`/Users/abuusama/projects/whatsapp-agent-tui/node_modules/@earendil-works/pi-agent-core/dist/harness/skills.d.ts`
and `skills.js`.

- `loadSkills(env: ExecutionEnv, dirs: string | string[])` →
  `{ skills: Skill[]; diagnostics: SkillDiagnostic[] }`. Multi-directory
  input; a missing input directory is silently skipped (`not_found` ignored;
  any other stat error becomes a diagnostic).
- Discovery: recursive. In each directory, if an entry named exactly
  `SKILL.md` exists, that file is loaded and traversal of the directory
  stops (`skills.js:88-102`) — the whole directory belongs to one skill, and
  nested `SKILL.md` files below it are not loaded. Otherwise entries are
  walked in locale order; dot-entries and `node_modules` are skipped; at the
  top level of each input directory only, plain `*.md` files also load as
  skills (`includeRootFiles`). Symlinks are resolved via
  `canonicalPath`/`fileInfo` and followed.
- Ignore support: `.gitignore`, `.ignore`, `.fdignore` are read in every
  visited directory and applied with path prefixes relative to the input
  root, including negation patterns (`skills.js:129-190`).
- Frontmatter handling (`skills.js:191-266`): CRLF-normalized; a file
  without frontmatter parses as empty frontmatter. `name` is optional and
  defaults to the parent directory name; validation warns (but still loads)
  when the name doesn't match the parent directory, exceeds 64 chars, uses
  characters outside `a-z0-9-`, or has leading/trailing/double hyphens.
  `description` is required, ≤1024 chars; missing or empty → the skill is
  dropped (with an `invalid_metadata` warning). `disable-model-invocation:
true` is read into the skill; no other frontmatter field (`license`,
  `compatibility`, `metadata`, `allowed-tools`) is interpreted, and unknown
  fields are not errors. The limits match the Agent Skills spec exactly.
- Diagnostics: warnings only (`type: "warning"`), five stable codes —
  `file_info_failed | list_failed | read_failed | parse_failed |
invalid_metadata` — each with message and path. The loader never throws on
  malformed input.
- No precedence or dedup: skills with duplicate names from different
  directories are all returned; collision policy is the caller's.
- `loadSourcedSkills<TSource, TSkill>(env, inputs: Array<{ path; source }>,
mapSkill?)` tags every skill and diagnostic with the given `source`,
  optionally mapping each skill. From the doc comment: "Source values are
  preserved exactly… The agent package does not interpret source values;
  applications define their own provenance shape."
- `formatSkillInvocation(skill, additionalInstructions?)` wraps the body in
  `<skill name="…" location="…">` and states "References are relative to
  <skill dir>" — activation-time injection is already provided.

Implication for Ambient: the loader already implements the Agent Skills
contract and multi-scope input with provenance; the only policy Ambient must
add is the scope list (`~/.ambient/skills`, `~/.ambient/chats/<id>/skills`),
the chat-shadows-home collision rule, and surfacing diagnostics.
