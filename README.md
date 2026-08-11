# whatsapp-agent-tui

A one-pane WhatsApp workbench for the terminal. Pair by scanning a QR, then read
and send in your chats. Built on [`whatsappd`](https://www.npmjs.com/package/whatsappd)
for the account and [`agentic-tui-kit`](https://www.npmjs.com/package/agentic-tui-kit)
for the workbench, with credentials and the local mirror in libSQL.

```bash
vp install
bun run start          # or: vp run start
```

The workbench claims the account on launch. With no stored credentials it shows
a pairing QR: **WhatsApp → Settings → Linked devices → Link a device**. Once you
scan, it syncs and the chat list fills in.

The QR needs about **70 columns × 40 rows**. Below that the pairing view says so
and prints the size it needs, rather than drawing a code that will not scan.

## Layout

One workspace, one window, a sidebar and a content pane. The sidebar lists chats
by their last message, newest first, each row carrying when it last moved — a
time today, a weekday this week, a date beyond. A settings row sits at the
bottom; the content pane is either a chat transcript or the connection screen.
Nothing floats, nothing docks.

In a transcript your messages sit on the right and everyone else's on the left;
`@` marks a person in the sidebar and `#` a group.

| Key             | Does                                                 |
| --------------- | ---------------------------------------------------- |
| `←` `↑↓` `⏎`    | focus the sidebar, walk it, open the row             |
| `f`             | filter the sidebar — all · direct · groups           |
| `i`             | focus the composer · `⏎` sends · `Esc` cancels       |
| `o`             | load earlier messages from the local mirror          |
| `m`             | mark the open chat read                              |
| `c` `d` `x` `u` | connect · disconnect · reconnect · unlink (settings) |
| `Ctrl+,`        | open settings                                        |
| `Ctrl+P`        | command palette — every action, by name              |
| `q` / `Ctrl+C`  | quit                                                 |

## History loads itself

Connecting starts a background walk that reads every chat's stored history into
memory, newest chat first, so a chat you open is already full. `o` is left for
the one case the walk stops short of.

It reads the **local mirror**, never WhatsApp — a disk walk, not a network one.
The whole of a 69-chat, 1,756-message account loads in about 130ms. What bounds
it is memory rather than time: the client never evicts what it has paged, so the
walk stops at `WHATSAPP_BACKFILL_LIMIT` messages (default `20000`) and says so
on the settings screen. Past that, `o` is the way further.

Nothing here asks the phone for history it has not already delivered. That is a
separate request with a phone dependency and no guaranteed answer, and this
workbench does not make it — so "start of saved history" always means _saved
here_, never _all there is_.

## Storage

`./data` holds everything for one account, overridable with `WHATSAPP_DATA_DIR`:

- `whatsapp.db` — credentials and the current mirror, in libSQL. It opens in WAL,
  so `whatsapp.db-wal` and `whatsapp.db-shm` sit beside it. Move, copy, or delete
  the three together.
- `media/` — attachment bytes, as private immutable objects.
- `whatsapp.log` — everything this process would otherwise print. A full-screen
  terminal renders into the same descriptor a logger writes to, so anything
  printed while the UI is up shreds the frame. `WA_LOG_LEVEL` (default `warn`)
  sets how much lands here; `tail -f data/whatsapp.log` while it runs.

`WHATSAPP_ACCOUNT_ID` (default `main`) scopes every durable record and the
single-writer lease. Two processes on one account is refused before a socket
opens, so a second `bun run start` fails rather than fighting the first.

## One honest limit

**Unlink is local.** It erases stored credentials so the next connect pairs
again. The device stays listed on your phone until you remove it there.

## Every operation is an action

Buttons, keys, the palette, tests, and any agent driving this app go through one
typed action each — there is no agent-only path and no test-only imitation of
the UI. `Ctrl+P` lists them; the ids are in `src/whatsapp/ids.ts`.

## Proof

```bash
bun test                 # 21 tests: QR, labels, backfill, logging, full journey
vp check                 # format, lint, typecheck
bun run prove:pairing    # opens a real WhatsApp session and prints a live QR
```

`bun test` drives the real workbench headlessly over a deterministic session and
writes screenshots and an MP4 to `artifacts/journey/`. It lifts the QR off the
rendered frame and decodes it with a real QR decoder, so "a code is drawn" and
"a phone can read this code" are separate, tested claims.

`bun run screens` renders the same workbench against a scripted session and
prints the screen, which is how a layout change gets looked at without a phone:

```bash
bun run screens                            # a 1:1 chat, both directions
bun run screens group                      # a group, several senders
SCREENS_BULK=400 bun run screens long      # more history than a screen holds
SCREENS_KEYS=left,f bun run screens        # press keys before the capture
```
