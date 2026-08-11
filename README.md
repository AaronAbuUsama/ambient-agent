# Ambient

Ambient is a backend-only conversational agent under construction. The current
backend foundation owns one durable WhatsApp account, resumes its authenticated
session, loads all locally retained chat history, and maintains a separate
Ambient database for observations, runs, tool calls, inbox work, tasks, memory
records, and evaluations.

```bash
pnpm install
pnpm start
```

The process claims the configured account on launch and runs until `SIGINT` or
`SIGTERM`. This hard-cut backend currently expects credentials already retained
in its data directory. A new pairing flow will return as a channel capability,
not as a terminal interface.

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
[`plan.md`](./plan.md).
