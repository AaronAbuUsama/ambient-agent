/**
 * The Root pokes a speaker into starting.
 *
 * A Conversation run only ever begins from retained work, and a
 * newly-activated speaker deliberately does not drain backlog — so a chat
 * just switched on stays silent until someone else speaks. Its own account
 * cannot break that silence either: outbound messages are dropped at
 * ingestion by design.
 *
 * This is the Root doing what the Root is for: creating the reason to act,
 * through the same retained records every other run uses. The speaker still
 * decides what to say, and may still decide to say nothing.
 *
 *   pnpm exec tsx src/ops/poke.ts <chat-slug> ["what to do"]
 *
 * The chat is named by its slug — the home's own safe label — so no real
 * identifier enters this file.
 */

import { openAmbientDatabase } from "../database/database";
import { ambientHome } from "../home/init";
import { scanMandates } from "../home/mandates";

const DEFAULT_NOTE =
  "You're back online in this group. Kick things off: say hello, then start working out what is " +
  "still actually broken and what has already been fixed — ask the person filing the reports " +
  "what still happens on the build he is running now, and ask the developer what he has shipped.";

const slug = process.argv[2];
const note = process.argv[3] ?? DEFAULT_NOTE;

if (!slug) {
  console.error('usage: poke.ts <chat-slug> ["what to do"]');
  process.exit(1);
}

const home = ambientHome(process.env);
const mandate = scanMandates(home).active.find((chat) => chat.slug === slug);

if (!mandate) {
  console.error(`no active chat with slug "${slug}"`);
  process.exit(1);
}
if (mandate.mode !== "responding") {
  console.error(`chat "${slug}" is ${mandate.mode}; a listening speaker never speaks`);
  process.exit(1);
}

const database = await openAmbientDatabase(`file:${home}/state/ambient.db`);

try {
  const { observations, inbox } = database.repositories;
  const now = new Date().toISOString();
  const id = `root-poke:${Date.now()}`;

  const { observation } = await observations.retain({
    id: crypto.randomUUID(),
    source: "whatsapp",
    accountId: "main",
    nativeId: id,
    conversationId: mandate.chatId,
    occurredAt: now,
    kind: "message",
    payload: {
      version: 1,
      messageId: id,
      chatId: mandate.chatId,
      // The Root is the author. Attributing this to a group member would put
      // words in their mouth, in a record memory later reads as evidence.
      sender: { id: "root@ambient", mode: "pn" },
      fromMe: false,
      timestamp: Date.now(),
      live: true,
      isGroup: true,
      text: note,
    },
  });

  const { accepted } = await inbox.enqueue({
    conversationId: mandate.chatId,
    kind: "message",
    referenceId: observation.id,
    createdAt: now,
  });

  console.log(JSON.stringify({ chat: slug, observation: observation.id, enqueued: accepted }));
} finally {
  await database.close();
}
