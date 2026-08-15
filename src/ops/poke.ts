/**
 * The Root pokes the speaker.
 *
 * A Conversation run only ever begins from retained work, and a
 * newly-activated speaker deliberately does not drain backlog — which is why
 * a chat that has just been switched on stays silent until someone speaks.
 * This is the Root doing what the Root is for: creating the reason to act,
 * through the same retained records every other run uses. The speaker still
 * decides what to say, and may still decide to say nothing.
 */

import { openAmbientDatabase } from "../database/database";

const CHAT = process.env.POKE_CHAT!;
const SENDER = process.env.POKE_SENDER!;
const TEXT = process.env.POKE_TEXT!;

const database = await openAmbientDatabase(`file:${process.env.HOME}/.ambient/state/ambient.db`);

try {
  const now = new Date().toISOString();
  const nativeId = `root-poke:${Date.now()}`;

  const { observation } = await database.repositories.observations.retain({
    id: crypto.randomUUID(),
    source: "whatsapp",
    accountId: "main",
    nativeId,
    conversationId: CHAT,
    occurredAt: now,
    kind: "message",
    payload: {
      version: 1,
      messageId: nativeId,
      chatId: CHAT,
      sender: { id: SENDER, mode: "pn" },
      fromMe: false,
      timestamp: Date.now(),
      live: true,
      isGroup: true,
      text: TEXT,
    },
  });

  const { accepted } = await database.repositories.inbox.enqueue({
    conversationId: CHAT,
    kind: "message",
    referenceId: observation.id,
    createdAt: now,
  });

  console.log(JSON.stringify({ observationId: observation.id, enqueued: accepted }, null, 2));
} finally {
  await database.close();
}
