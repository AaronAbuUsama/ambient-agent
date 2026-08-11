/**
 * Render the workbench headlessly against a scripted session and print the
 * screen, so a layout change can be seen without a phone or a live terminal.
 *
 * ```bash
 * bun run screens            # a 1:1 chat, both directions
 * bun run screens group      # a group chat, several senders
 * bun run screens long       # more messages than the viewport holds
 * bun run screens settings   # the connection pane
 * ```
 *
 * `SCREENS_BULK` sets how much history the `long` scenario stores, and
 * `SCREENS_KEYS` presses shortcuts before the capture — `SCREENS_KEYS=left,f`
 * for the sidebar filter.
 */
import { driveHeadlessTui } from "agentic-tui-kit/testing";
import { fileMediaStore, libsqlBackend, memoryBackend } from "whatsappd";
import { createTestWhatsAppSession, textMessage } from "whatsappd/testing";
import { join } from "node:path";
import { createWhatsAppWorkbench } from "../src/app";

const view = process.argv[2] ?? "chat";
const me = "15559990000@s.whatsapp.net";
const alice = "15550001111@s.whatsapp.net";
const bob = "15550002222@s.whatsapp.net";
const carol = "15550003333@s.whatsapp.net";
const group = "120363000000000001@g.us";
const standup = "120363000000000002@g.us";

const driver = createTestWhatsAppSession({
  identity: { jid: "15559990000:7@s.whatsapp.net", pushName: "Aaron", phoneE164: "+15559990000" },
});
// `SCREENS_DATA_DIR` renders a real mirror instead of the scripted one — every
// message then has to be paged in, which is the only way to see the states that
// only stored history produces. Point it at a *copy*: the workbench takes the
// account lease and the live instance would lose it.
const dataDir = process.env.SCREENS_DATA_DIR;
const backend = dataDir
  ? libsqlBackend({
      url: `file:${join(dataDir, "whatsapp.db")}`,
      accountId: process.env.SCREENS_ACCOUNT_ID ?? "main",
      media: fileMediaStore({ directory: join(dataDir, "media") }),
    })
  : memoryBackend();
const workbench = createWhatsAppWorkbench({
  accountId: dataDir ? (process.env.SCREENS_ACCOUNT_ID ?? "main") : "preview",
  createBackend: () => backend,
  openSession: () => driver.session,
});
const tui = await driveHeadlessTui(workbench.app, {
  ...workbench.runtimeOptions,
  viewport: { width: 120, height: 40 },
});
const agent = { actor: { kind: "agent", id: "preview" }, source: "test" } as const;

await tui.invoke(workbench.whatsapp.actions.connect, {}, agent);
await driver.emit({ type: "connection", status: { phase: "online" } });

// A real mirror brings its own contacts, groups and history; scripting more on
// top would only bury it.
for (const [id, displayName] of dataDir
  ? []
  : ([
      [alice, "Alice Nguyen"],
      [bob, "Bob"],
      [carol, "Carol Diaz"],
    ] as const)) {
  await driver.emit({
    type: "contact",
    contact: { id, nativeIds: [id], displayName, at: Date.now() },
  });
}
for (const [id, subject] of dataDir
  ? []
  : ([
      [group, "Weekend plans"],
      [standup, "Platform standup"],
    ] as const)) {
  await driver.emit({ type: "group", group: { kind: "metadata", id, subject, at: Date.now() } });
}

type Line = readonly [chatId: string, text: string, fromMe: boolean, sender?: string];

const conversation: readonly Line[] = [
  [alice, "are we still on for friday?", false],
  [alice, "yes — 7pm at the usual place, I booked a table for four", true],
  [alice, "perfect, see you then", false],
  [
    alice,
    "one more thing: do you want me to bring the projector, or is the room already wired for it?",
    true,
  ],
  [alice, "already wired, just bring yourself", false],
  [group, "standup in five", false, carol],
  [group, "on my way", true],
  [group, "the deploy finished, all green across every region and shard", false, bob],
  [standup, "blocked on the migration review", false, bob],
  [bob, "shipped the build", false],
];

const bulk: readonly Line[] = Array.from(
  { length: Number(process.env.SCREENS_BULK ?? 40) },
  (_, index) => {
    const fromMe = index % 3 === 0;
    return [
      alice,
      fromMe
        ? `outgoing ${index}: a deliberately long line that runs to the right edge so any clipped column shows`
        : `incoming ${index}: a deliberately long line that runs to the right edge so any clipped column shows`,
      fromMe,
    ] as const;
  },
);

const script = dataDir ? [] : view === "long" ? bulk : conversation;
let index = 0;
for (const [chatId, text, fromMe, sender] of script) {
  index += 1;
  await driver.emit({
    type: "message",
    message: textMessage({
      id: `m${index}`,
      chatId,
      text,
      fromMe,
      sender: sender ?? (fromMe ? me : chatId),
      isGroup: chatId.endsWith("@g.us"),
      timestamp: Date.now() - (script.length - index) * 60_000,
    }),
  });
}

// A real mirror has to be paged in before anything can be opened.
await Bun.sleep(dataDir ? 1200 : 150);
const opened = dataDir
  ? (workbench.engine.getSnapshot().chats[0]?.chatId ?? "")
  : view === "group"
    ? group
    : alice;
if (view !== "settings" && opened) {
  await tui.invoke(workbench.whatsapp.actions.openChat, { chatId: opened }, agent);
  await Bun.sleep(250);
}

// `SCREENS_KEYS=f,f,left` drives the same shortcuts a human would press.
for (const key of (process.env.SCREENS_KEYS ?? "").split(",").filter(Boolean)) {
  await tui.key(key);
  await Bun.sleep(80);
}

console.log(await tui.screen());
const { backfill } = workbench.engine.getSnapshot();
const panelPages = tui.runtime.actions
  .invocations()
  .filter((record) => record.actionId === "whatsapp.load-older").length;
console.log(
  `backfill: ${backfill.state} · ${backfill.messages} messages · ${backfill.done}/${backfill.total} chats · ${panelPages} pages from the panel`,
);
await tui.finish();
await workbench.engine.dispose();
