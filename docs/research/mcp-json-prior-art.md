# mcp.json prior art across MCP clients

Research for the `~/.ambient/mcp.json` schema decision (map #1, ticket #18).
Surveyed 2026-08-12 against primary vendor docs.

## Answer first

- **The de facto standard is top-level `"mcpServers"`** with a name-keyed object
  of server stanzas. Claude Code, Claude Desktop, Cursor, and Windsurf all use
  it verbatim. VS Code (`"servers"`), Zed (`"context_servers"`), and Codex
  (TOML `[mcp_servers.*]`) are the outliers — and READMEs overwhelmingly print
  the `mcpServers` form.
- **Stdio stanza:** `{ "command": string, "args": string[], "env": {k:v} }`.
  Identical across every JSON client. This is the stanza a random MCP server
  README prints, and under an `mcpServers` root it pastes unchanged.
- **Remote stanza:** `{ "url": string, "headers": {k:v} }` plus a `type`
  discriminator (`"http"` / `"sse"`). Clients disagree on whether `type` is
  required: Claude Code rejects `url`-without-`type`; Cursor infers; Windsurf
  even renames the field (`serverUrl`).
- **Credentials:** the ecosystem convention in READMEs is raw values in the
  `env` block (`"API_KEY": "your-key-here"`). Every serious client layers
  variable expansion on top: Claude Code `${VAR}` / `${VAR:-default}`;
  Cursor / VS Code / Windsurf `${env:VAR}`. VS Code additionally has an
  interactive `inputs` prompting mechanism, which only makes sense in an
  editor with a UI.
- **Ambient recommendation:** adopt `mcpServers` + the common stanza fields
  exactly; expand both `${VAR}` and `${env:VAR}` (env-only, fits the
  secrets-in-env rule); accept `type` and infer `url` → http when absent
  (maximizes paste success); adopt a per-server `disabled: true` flag (cheap,
  useful for a hot-reloaded agent-authorable file); ignore scoping, `inputs`,
  `envFile`, `auth`, `dev/watch`, and `headersHelper`.

## Per-client evidence

### Claude Code — `.mcp.json`

Source: <https://code.claude.com/docs/en/mcp> (redirect target of
docs.claude.com/en/docs/claude-code/mcp).

- **Top-level key:** `"mcpServers"`, in `.mcp.json` at the project root
  (project scope) and inside `~/.claude.json` (local and user scopes).
- **Scoping model:** three scopes matched by server name — _local_
  (`~/.claude.json`, per-project, private), _project_ (`.mcp.json`, checked
  into VCS, requires interactive approval), _user_ (`~/.claude.json`, all
  projects). Precedence local > project > user; the winning entry is taken
  whole, fields are never merged across scopes.
- **Stdio stanza:** `command`, `args`, `env`. Optional per-server `timeout`
  (ms, tool execution).
- **Remote stanza:** `type` (`"http"`, `"sse"`, `"ws"`; `"streamable-http"`
  accepted as an alias of `"http"` precisely so that specs copied from server
  docs "work without modification"), `url`, `headers`, plus `headersHelper`
  and `alwaysLoad`. An entry with `url` but no `type` is a hard error — Claude
  Code reads a typeless entry as stdio, skips the server, and reports
  `add "type": "http" (or "sse" / "ws")`.
- **Env expansion:** `${VAR}` and `${VAR:-default}`, applied in `command`,
  `args`, `env`, `url`, and `headers`. A missing variable with no default
  loads anyway with a warning and the literal `${VAR}` text left in place.

```json
{
  "mcpServers": {
    "api-server": {
      "type": "http",
      "url": "${API_BASE_URL:-https://api.example.com}/mcp",
      "headers": { "Authorization": "Bearer ${API_KEY}" }
    }
  }
}
```

### Claude Desktop — `claude_desktop_config.json`

Source: <https://modelcontextprotocol.io/quickstart/user> (the MCP project's
own quickstart, using Claude Desktop as the reference client).

- **Location:** `~/Library/Application Support/Claude/claude_desktop_config.json`
  (macOS), `%APPDATA%\Claude\claude_desktop_config.json` (Windows).
- **Top-level key:** `"mcpServers"`. Stdio only in this file (remote servers
  go through the Connectors UI, not the JSON). Stanza is exactly
  `command` / `args` / `env`.
- **Credentials:** raw values in `env` — the docs' own troubleshooting example
  puts `"BRAVE_API_KEY": "..."` directly in the block. No variable expansion
  documented. This file is the shape most server READMEs print, which is why
  `mcpServers` became the ecosystem default.

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/username/Desktop"]
    }
  }
}
```

### Cursor — `.cursor/mcp.json`

Source: <https://cursor.com/docs/context/mcp>.

- **Locations:** `.cursor/mcp.json` (project), `~/.cursor/mcp.json` (global).
- **Top-level key:** `"mcpServers"`.
- **Stdio stanza:** `command`, `args`, `env`, plus `envFile` (stdio only).
- **Remote stanza:** `url`, `headers`, `type` _optional_ — Cursor infers the
  transport from the presence of `url`.
- **Extras:** `disabled` toggle, `auth` (OAuth object) on remote servers.
- **Interpolation:** VS Code-style `${env:NAME}` plus editor context variables
  (`${workspaceFolder}`, `${userHome}`, ...).

### VS Code — `.vscode/mcp.json`

Source: <https://code.visualstudio.com/docs/copilot/customization/mcp-servers>.

The deliberate divergent. Documented because its differences are the ones an
Ambient schema must decide to accept or reject:

- **Top-level keys:** `"servers"` (not `mcpServers`) and optional `"inputs"`.
- **`type` field:** `"stdio"` / `"http"` / `"sse"` per server.
- **Stdio:** `command`, `args`, `env`, plus dev-loop fields `dev` and `watch`.
- **Remote:** `url`, `headers`.
- **Secrets:** the `inputs` block declares prompted variables
  (`"type": "password"`) referenced as `${input:id}`; VS Code prompts the
  user in the editor UI and stores the value. `${env:VAR}` reads real
  environment variables.
- **Scopes:** workspace `.vscode/mcp.json` (shared via VCS) and a per-user
  MCP config file.

VS Code's own docs note the consequence of diverging: pasting a stock README
stanza into VS Code fails until the user renames the root key and adds `type`.

### Windsurf — `mcp_config.json`

Source: <https://docs.windsurf.com/windsurf/cascade/mcp> (currently redirects
to docs.devin.ai/desktop/cascade/mcp).

- **Location:** `~/.codeium/windsurf/mcp_config.json`.
- **Top-level key:** `"mcpServers"`. Stdio stanza identical
  (`command` / `args` / `env`).
- **Remote:** `serverUrl` (their historical field name; `url` also accepted)
  plus `headers`. Extra: `disabledTools` array per server.
- **Interpolation:** `${env:VAR}` and `${file:/path}` across command, args,
  env, url, and headers.

### Codex and Zed, briefly

- **OpenAI Codex CLI** (<https://developers.openai.com/codex/mcp>,
  <https://developers.openai.com/codex/config-reference>): not JSON at all —
  `~/.codex/config.toml` with `[mcp_servers.<name>]` tables carrying
  `command` / `args` / `env` or `url`. Same logical shape (`mcp_servers` is
  the snake_case of `mcpServers`), different serialization; READMEs now often
  print a second TOML stanza for Codex users, which itself confirms JSON
  `mcpServers` as the primary form.
- **Zed** (<https://zed.dev/docs/ai/mcp>): `"context_servers"` inside Zed's
  main `settings.json`; stanzas are the standard `command` / `args` / `env`
  and `url` / `headers`. Divergent root key, standard stanza.

### Copy-paste compatibility table

| Client         | Root key               | Stdio fields     | Remote fields     | `type`           | Expansion                 | README stanza pastes unchanged?  |
| -------------- | ---------------------- | ---------------- | ----------------- | ---------------- | ------------------------- | -------------------------------- |
| Claude Desktop | `mcpServers`           | command/args/env | — (UI)            | no               | none                      | yes (it _is_ the README shape)   |
| Claude Code    | `mcpServers`           | command/args/env | url/headers       | required for url | `${VAR}`, `${VAR:-d}`     | yes (stdio); remote needs `type` |
| Cursor         | `mcpServers`           | command/args/env | url/headers       | optional         | `${env:VAR}`              | yes                              |
| Windsurf       | `mcpServers`           | command/args/env | serverUrl/headers | no               | `${env:VAR}`, `${file:}`  | yes (stdio)                      |
| VS Code        | `servers`              | command/args/env | url/headers       | required         | `${env:VAR}`, `${input:}` | **no** — rename root, add type   |
| Zed            | `context_servers`      | command/args/env | url/headers       | no               | none documented           | no — different root              |
| Codex          | `[mcp_servers.*]` TOML | command/args/env | url               | no               | none                      | no — different language          |

## Synthesis for Ambient

**Shape.** Use `"mcpServers"` as the sole top-level key and the common stanza
verbatim: stdio `{ command, args?, env? }`, remote `{ type, url, headers? }`.
That is the intersection of Claude Desktop, Claude Code, Cursor, and Windsurf,
and it is the exact text a random MCP server README prints. Any other root key
(VS Code's `servers`) breaks the ticket's stated purpose — verbatim
copy-paste — for zero gain.

**Transport discrimination.** Accept `type` (`"stdio"`, `"http"`, `"sse"`,
alias `"streamable-http"` → `"http"`, per Claude Code's own compatibility
rationale) but don't require it: infer stdio from `command`, http from `url`,
Cursor-style. Claude Code's stricter url-without-type error exists because it
defaults typeless entries to stdio; Ambient validates at the boundary and can
normalize instead, which lets more README stanzas paste clean. Reject a stanza
with both `command` and `url`, or neither.

**Credentials.** Fits Ambient's existing rules directly (secrets only in
environment variables; validate once at the boundary; never persist credential
values):

- Expand `${VAR}` / `${VAR:-default}` (Claude Code syntax) _and_ `${env:VAR}`
  (Cursor/VS Code/Windsurf syntax) in `command`, `args`, `env`, `url`, and
  `headers`. Both resolve to environment variables only — no file reads, no
  editor context variables, no prompting. Supporting both syntaxes is a few
  lines and means pasted stanzas from either dialect work.
- Raw literal values in `env`/`headers` must still parse (that is what
  READMEs contain), but Ambient should fail closed on unresolvable `${...}`
  references — unlike Claude Code's warn-and-pass-literal behaviour, which
  would ship the literal `${API_KEY}` string to a server. Hot reload
  re-validates the whole document each time; a bad file keeps the last good
  policy.
- Do **not** adopt VS Code `inputs` (needs an interactive UI; Ambient is a
  headless daemon) or Windsurf `${file:}` (a second secret channel that
  bypasses the env-only rule).

**Divergent features worth adopting vs ignoring.**

- _Adopt:_ per-server `disabled: true` (Cursor). For a hot-reloadable,
  agent-authorable policy file this is the natural "turn it off without
  deleting the stanza" verb, and it round-trips agent edits safely.
- _Ignore:_ scoping (Ambient has exactly one global file — scoping is a
  client-workspace concept), `envFile`, OAuth `auth` blocks, `dev`/`watch`,
  `headersHelper`, `timeout`, `alwaysLoad`, `disabledTools`. Any of these can
  be added later as optional fields without breaking existing documents;
  none earn a slot now.

**Surprise worth recording:** the ecosystem is converging deliberately, not
accidentally — Claude Code accepts `streamable-http` as a `type` alias with
the explicit rationale that "configurations copied from server documentation
work without modification". Copy-paste compatibility is a design goal the
major vendors already optimize for; Ambient choosing `mcpServers` rides that
current rather than fighting it.
