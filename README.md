# Ambient

Ambient is a backend-only conversational agent under construction. The current
backend foundation owns one durable WhatsApp account, resumes its authenticated
session, loads all locally retained chat history, and maintains a separate
Ambient database for observations, runs, tool calls, inbox work, tasks, memory
records, and evaluations. Each new live inbound text message is now retained
exactly once as one Observation plus one pending Conversation Inbox item.
Conversation scheduling and model behavior are implemented behind an opt-in
safety switch.

```bash
pnpm install
pnpm start
```

The process claims the configured account on launch and runs until `SIGINT` or
`SIGTERM`. This hard-cut backend currently expects credentials already retained
in its data directory. A new pairing flow will return as a channel capability,
not as a terminal interface.

Conversation is disabled by default, so a normal `pnpm start` still invokes no
model and submits no outbound operation.

## Conversation

Set `CONVERSATION_ENABLED=true` to activate the durable Conversation scheduler.
It reconciles pending Inbox work on startup, coalesces rapid messages behind a
sliding debounce and maximum wait, leases one conversation at a time, and
freezes a bounded Inbox range into each Agent Run. Arrivals during a run remain
pending for the next run.

The role-specific Pi agent can recall evidence-backed memory, submit one scoped
`send_message` operation, or deliberately remain silent. Tool calls, model
configuration, run outcomes, claimed ranges, and Conversation contract
evaluations are retained.

Outbound mode defaults to `loopback`, which resolves the linked account's own
WhatsApp address and never lets the model choose a destination. Set
`CONVERSATION_OUTBOUND_MODE=conversation` only for an explicitly authorized
deployment that should reply to originating chats. WhatsApp sends use durable
idempotency keys derived from the oldest Inbox item in the run.

Scheduling defaults can be overridden with:

- `CONVERSATION_DEBOUNCE_MS` (default `750`)
- `CONVERSATION_MAXIMUM_WAIT_MS` (default `5000`)
- `CONVERSATION_LEASE_MS` (default `120000`)
- `CONVERSATION_MAXIMUM_ITEMS_PER_RUN` (default `50`)
- `CONVERSATION_INSTRUCTIONS`

The default `qwen` provider uses `QWEN_API_KEY` (or `DASHSCOPE_API_KEY`) and the
international DashScope OpenAI-compatible endpoint. Override the endpoint with
`QWEN_BASE_URL`. No live model or outbound proof is run by the test suite.

## WhatsApp ingestion

`whatsappd` first commits channel input to its accepted-source log. Ambient
follows that bounded log with its own durable sequence cursor. One transaction
deduplicates the native `(chat, message)` identity, retains the Observation,
queues its Inbox item, and advances the cursor. A crash before commit therefore
replays the batch; a crash after commit resumes after it.

On a fresh Ambient database, the cursor first watermarks the already retained
source log without waking Conversation. This separates future live work from the
historical mirror that Memory will import under its own policy.

This first cut intentionally wakes Ambient only for new incoming text messages.
Historical messages, the linked account's own messages, and non-text payloads
remain separate policies for later cuts.

An opt-in live proof listens for one new incoming text message, retains it, and
exits without sending anything:

```bash
pnpm proof:whatsapp-ingestion
```

The proof requires an already authenticated account and times out after two
minutes. The receive-only live proof passed on 2026-08-11 without sending an
outbound message.

## History backfill

`whatsappd` pages saved messages from its local mirror rather than exposing one
bulk history read. Ambient therefore performs an explicit background walk:

- every known chat is visited, newest chat first;
- pages are loaded serially, one local read at a time;
- the complete retained mirror is loaded by default;
- new chats trigger another account-wide pass;
- progress is exposed as `running`, `complete`, `capped`, or `stalled`;
- the future Memory Analyst can await the terminal backfill state before its
  first account-wide analysis.

Set `WHATSAPP_BACKFILL_LIMIT` to a positive multiple of the 25-message storage
page size only when a deployment needs a memory safety limit. An unset value
means all locally retained history.

This does not request missing history from the phone. “All history” means all
history already retained in the local WhatsApp mirror.

## Storage

`./data` holds everything for one account, overridable with `WHATSAPP_DATA_DIR`:

- `whatsapp.db` — credentials and the current mirror, in libSQL. It opens in WAL,
  so `whatsapp.db-wal` and `whatsapp.db-shm` sit beside it. Move, copy, or delete
  the three together.
- `ambient.db` — durable Ambient product state. Repeatable migrations run before
  WhatsApp connects. Override its location with `AMBIENT_DATABASE_URL`.
- `media/` — attachment bytes, as private immutable objects.
- `whatsapp.log` — redacted WhatsApp session logs. `WA_LOG_LEVEL` defaults to
  `warn`.

`WHATSAPP_ACCOUNT_ID` (default `main`) scopes every durable record and the
single-writer lease. Two processes on one account is refused before a socket
opens, so a second `pnpm start` fails rather than fighting the first.

Role model settings are resolved at startup and snapshotted into every Agent Run.
`MODEL_PROVIDER` and `AMBIENT_MODEL` provide shared defaults; role-specific
variables such as `CONVERSATION_MODEL`, `WORKER_MODEL`, and `MEMORY_MODEL`
override them.

## Toolchain and schema

Ambient runs on Node.js and uses pnpm. Drizzle defines the application schema in
`src/database/schema.ts`, generates versioned migrations under `drizzle/`, and
backs the typed repositories in `src/database/`.

```bash
pnpm db:generate
```

## Validation

```bash
pnpm check
pnpm test
```

The target architecture and implementation sequence are in
[`plan.md`](./plan.md). The current position, complete system map, and proof gates
for the next cuts are in [`docs/ambient-map.html`](./docs/ambient-map.html).
