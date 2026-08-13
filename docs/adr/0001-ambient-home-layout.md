# The Ambient home layout: three planes, one machine directory

Ambient's runtime home is `~/.ambient/`, laid out so a stranger can tell what
is safe to touch without reading anything but the tree — and so the Root can
author policy files without ever nearing deployment config or machine state.
Decided on the home-litigation map
([Home layout](https://github.com/AaronAbuUsama/ambient-agent/issues/3)),
reacting to the walking-skeleton prototype
(`prototype/walking-skeleton-home`), not the sketch alone.

```
~/.ambient/
  README.md           regenerable orientation file, seeded at init
  config.yaml         deployment: providers, credential env refs, account.
                      Restart-class; operator-owned; never hot-reloaded.
  mcp.json            global MCP servers. Policy plane; hot; Root-authorable;
                      conventional ecosystem filename; may be absent.
  skills/             home-scoped skills (SKILL.md dirs only — the loader
                      treats stray root .md prose as a broken skill)
  chats/<slug>/
    mandate.yaml      the whole grant, one file: chatId, mode, instructions,
                      memory brief. Policy; living; CLI-created;
                      Root-authorable via tool only (ADR 0002).
    skills/           chat-scoped skills (shadow home skills by name)
    wiki/             derived per-chat projection; regenerable; safe to
                      delete. Shape undecided (named seam).
  work/               reserved seam for worker workdirs. Not designed.
  state/              machine-owned. The runtime alone writes here; humans
                      and the Root never do. Holds ambient.db (+ WAL/SHM),
                      the whatsappd territory (mirror, media, auth), locks,
                      caches — every future machine file lands here.
```

The rule that carries everything: **everything outside `state/` is human and
Root territory; everything inside `state/` is Ambient's alone.** The
gitignore, the backup story, and the Root's write boundary are all this one
sentence.

Per-record test (who writes it, how often, does it need transactions):
authored → policy plane, files outside `state/`; transactional coordination →
protocol plane, SQLite inside `state/`; derived → projection plane,
regenerable files (per-chat `wiki/`).

## Considered options

- Machine files at the top level (the brainstorm sketch: `ambient.db`,
  `whatsapp/` beside `config.yaml`) — rejected: it recreates the observed
  `~/.claude` / `~/.codex` mess where a non-developer cannot tell what is
  safe to touch, and every dependent (gitignore, backups, Root boundary)
  must enumerate machine files forever.
- One config document (MCP as a `config.yaml` section) — rejected: MCP
  grants are hot, Root-authorable policy; providers and account are
  restart-class operator config. The temperature boundary should be a file
  boundary, and the conventional `mcp.json` name keeps ecosystem stanzas
  copy-pasteable.
- One file per chat (chat id inside `mandate.yaml`) — originally rejected
  because under keep-last-good a broken mandate could orphan the binding
  that keyed the kept row. **Superseded by ADR 0002 (2026-08-13)**:
  fail-closed keeps no row, so the split protects nothing; one
  `mandate.yaml` with `chatId` inside is the layout, and `chat.yaml` is
  retired.

## Consequences

- Migration moves today's `./data` contents into `state/`; init seeds
  `README.md` + `config.yaml` and creates the empty tree.
- A recursive watcher on the home can treat `chats/`, `skills/`, and
  `mcp.json` as the hot surface; `config.yaml` and `state/` are never
  watched as policy.
- Prose documentation never lives inside a `skills/` root (the pi loader
  diagnoses it on every load); orientation prose lives in the top-level
  `README.md`.
