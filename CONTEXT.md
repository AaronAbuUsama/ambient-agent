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

### Agents and delegation

**Agent definition**:
A named composition on disk — `agents/<name>/agent.yaml`: description, a
model role, instructions, and tools with per-tool constraints. Tools are
code; agents are data. Definitions are global; access is granted per chat.
Broken definitions are absent and loud, like broken chats.
_Avoid_: worker type, agent class, profile (the `worker_profile` column
stores a definition's name)

**Worker**:
The harness that runs any definition as one bounded objective with a
terminal result under a fenced lease — a run contract, not a kind of brain.
"GitHub filer" vs a future "code agent" is different YAML, not a new kind.

**Grant**:
A mandate's `agents:` entry — this chat's speaker may delegate to that
definition, optionally narrowing its constraints. Effective constraint =
definition ∩ grant; widening is an error. A grant is a disclosure
decision: chat content may flow to the agent's destinations.
_Avoid_: permission list, ACL

**Assignment**:
One durable delegated responsibility — a `tasks` row: objective, definition
name, chosen target, lease, result. Created by the speaker's delegate tool
(id derived from the run's claim, so a retried run adopts its own
delegation), claimed by the worker drain, returned to the chat as a
`task_update` inbox item — success or parked failure alike.
_Avoid_: task (in prose; the table name stays `tasks`), job

**Target**:
An assignment's destination (for GitHub: `owner/name`), chosen at creation,
recorded on the assignment, bound host-side. The model's tools carry no
destination axis.

**Recall**:
What a speaker knows, in two sources it sees as one: claims about the people
present, reachable through identity links, and the claims this conversation's
own evidence established — issues among them, since an issue is nobody's
identity. An empty query returns everything held here, so "how many are still
open" is answerable rather than guessable.
_Avoid_: injecting the ontology into every run; treating recall as search only

**Receipt**:
The retained `task_artifacts` row proving an external effect happened —
recorded at the tool boundary the moment the effect exists. The receipt is
the idempotency authority; the effect's embedded `Ambient-Task` marker
covers only the crash window before the receipt.
_Avoid_: asking the external system whether we already acted

**Attachment**:
Evidence an assignment carries into the effect it causes — media refs the
speaker named, validated against its own conversation, recorded on the
assignment, resolved to bytes host-side. Scoped exactly as a target is: the
worker's model never names a ref. An attachment that cannot be uploaded is
admitted in the report, never dropped in silence.

### Media

**Media ref**:
`media:v1:<sha256>` — the content address of retained bytes in the media
store. The retained observation keeps the ref and the caption; the bytes stay
in the store, and only a deterministic reader ever fetches them.
_Avoid_: passing bytes through records, prompts, or claims

**Description**:
What a picture was found to show, written once per unique blob and retained
under its content hash. Evidence in its own right — a claim may cite it as it
cites typed text. Its absence means nobody looked, never that there was
nothing to see.
_Avoid_: describing an image no description exists for; "the model saw it"

**Vision**:
A declared model capability, not an assumption. The harness silently swaps an
image for a placeholder on a model that lacks it, so a role needing vision
refuses to construct rather than describing nothing convincingly. Video is
retained and attachable but not interpreted — attaching is not understanding.

### Identity

**Native id**:
A WhatsApp id for one party — a person or a chat. WhatsApp gives one human
TWO forms, a phone form and a lid form, and both name the same person: they
link to one entity, and neither may become a second person. A chat or group
id is never a person's identity.
_Avoid_: jid/lid as separate concepts, phone number as identity

**Published name**:
The name a sender publishes for themselves, retained with every message they
send. Ambient reads it; Ambient never infers a person's name from message
text when it is present, and never invents one when it is absent.
_Avoid_: pushname (wire spelling), display name, contact name

**Linkable identity**:
A native id a message proves belongs to a real person: its author, the
author's other form, whoever it mentions, and the author of a quoted
message. One rule, owned in one place — memory validates proposals against
it and evaluation scores against the same rule.
_Avoid_: sender id (narrower — it excludes mentions and the second form)
