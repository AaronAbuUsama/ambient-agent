# Ambient

Ambient is one durable conversational entity working over WhatsApp for one
human. This glossary is the canonical vocabulary; when a doc or discussion
conflicts with it, this file wins or gets fixed.

## Language

### People

**Master**:
The human Ambient works for. A product concept: appears in mandates, prompts,
and the special Root chat.
_Avoid_: user, owner

**Operator**:
The human running the deployment: config, init, migration. Today the same
person as the master; the words name roles, not people.
_Avoid_: admin, host

### The home

**Home**:
The `~/.ambient/` tree — everything Ambient owns at runtime: config, durable
records, skills, chat folders. Written "the Ambient home" where the OS home
directory could be confused.
_Avoid_: space (unclaimed; reserved until worker workdirs are designed), data
directory, workspace

**Plane**:
One of three zones of the home, graded by who writes the records in it.

**Policy plane**:
Authored records: mandates, skills, MCP config. Written by the master or the
Root, read by the runtime. Legibility is the point.

**Protocol plane**:
Records through which roles coordinate transactionally: observations, inbox,
runs, leases, memory jobs. Written only by deterministic services.
_Avoid_: state (as a plane name), database plane

**Projection plane**:
Derived, regenerable views of durable truth: legible per-chat files, the wiki.
Never authoritative.
_Avoid_: cache, export

**State directory**:
The machine-owned area of the home (`state/`). The runtime alone writes it;
everything outside it is human and Root territory.
_Avoid_: data directory, internal files

### Chats and speakers

**Speaker**:
The Conversation Agent presence in one chat. All speakers are instances of the
same agent with different per-chat grants.

**Active chat**:
A chat whose folder holds a valid mandate. No folder = nothing exists
Ambient-side (whatsappd still mirrors every accepted message). Folder =
active: memory on by default, a speaker present, mode deciding speech.
_Avoid_: allowed chat (renamed 2026-08-13)

**Broken chat**:
A chat folder whose mandate is missing, unparseable, or invalid — or whose
chat id is claimed by another folder. Broken = inactive until a human fixes
the files; loud in logs and the CLI, never worked around.
_Avoid_: keep-last-good (rejected 2026-08-13)

**Mode**:
A speaker's speaking rights in its chat, and nothing else: `listening`
(silent; the default) or `responding`; `proactive` is reserved.

**Activation point**:
The machine-stamped moment a chat (re)activates or flips to `responding`.
The speaker answers messages from that moment forward; earlier messages are
memory's territory. Never authored.

**Mandate**:
The authored grant for one chat, one file (`mandate.yaml`): chat id, mode,
instructions, memory brief. Policy plane; created by the CLI, edited by the
Root only through a validating tool. The minimum mandate is the chat id
alone — active, listening, defaults.
_Avoid_: grant (capability grants are a different thing), manifest, policy
file, chat.yaml / binding file (retired 2026-08-13; the chat id line inside
the mandate is the binding)

**Memory brief**:
The mandate's statement of what a chat's memory is for. Carried to every
digest of that chat; when present it is the prime coverage rule. Memory
itself is default-on for every allowed chat — the brief shapes it, never
enables it.
_Avoid_: memory prompt, digestion focus

**Speaker record**:
The runtime mirror of the current valid mandate plus the activation
watermark. Protocol plane; the claim gate reads it transactionally. Active
records mirror exactly the set of valid folders — a stale or remembered
grant is never left running.
_Avoid_: Conversation mandate (retired 2026-08-12)

**Chat slug**:
The human label naming a chat folder: kebab-case `a-z0-9-`, at most 64
characters — the same rule skill names follow. A slug is never an identity:
code, logs, and durable records key on the chat id; the mandate's chat id
line maps folder to id; renaming a folder changes nothing durable. One chat
id is bound by at most one folder — two claimants make both chats broken.
_Avoid_: chat id as a folder name (ids contain `@`, dots, and phone numbers)
