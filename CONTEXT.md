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

**Allowed chat**:
A chat with a durable speaker record. No record = not allowed; every accepted
message is still observed and retained.

**Mode**:
A speaker's stance in its chat: `listening` (memory only, silent) or
`responding`; `proactive` is reserved.

**Activation point**:
The watermark before which a speaker never answers; messages earlier than it
are retained but not addressed.

**Mandate**:
The authored grant for one chat: mode, instructions, memory brief,
capabilities. Policy plane; written by the master or the Root. The speaker
record is its validated projection plus runtime watermark.
_Avoid_: grant (capability grants are a different thing), manifest, policy
file

**Speaker record**:
The runtime projection of a mandate plus the activation watermark. Protocol
plane; the claim gate reads it transactionally. Not the grant itself.
_Avoid_: Conversation mandate (retired 2026-08-12)

**Binding file**:
The per-chat file (`chat.yaml`) that binds a folder's slug to its real chat
id. Identity, written once when the folder is created; a broken mandate can
never touch it.
_Avoid_: chat config

**Chat slug**:
The human label naming a chat folder: kebab-case `a-z0-9-`, at most 64
characters — the same rule skill names follow. A slug is never an identity:
code, logs, and durable records key on the chat id; the folder's binding file
maps slug to id; renaming a folder changes nothing durable. One chat id is
bound by at most one folder.
_Avoid_: chat id as a folder name (ids contain `@`, dots, and phone numbers)

### Memory

**Digest window**:
The bounded, ordered slice of one chat's retained messages that one memory
job digests. Later windows see the ontology earlier windows built.

**Digest cursor**:
The per-chat watermark of what memory has digested. Distinct from the
activation point: answering and remembering have different boundaries.
_Avoid_: memory watermark, activation point (that one gates answering)
