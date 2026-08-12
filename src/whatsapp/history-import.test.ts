import { expect, test } from "vite-plus/test";
import { createClient } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { openAmbientDatabase } from "../database/database";
import { importChatHistory } from "./history-import";

const payloadSchema = z.looseObject({
  messageId: z.string(),
  sender: z.looseObject({ id: z.string() }).optional(),
  kind: z.string(),
  text: z.string().optional(),
  media: z.looseObject({ ref: z.string().optional(), caption: z.string().optional() }).optional(),
  context: z
    .looseObject({
      mentions: z.array(z.string()).optional(),
      quoted: z.looseObject({ from: z.string(), id: z.string() }).optional(),
    })
    .optional(),
});

test("history import keeps real authors, drops group-id senders, retains media, never creates Inbox work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ambient-import-"));
  const mirrorUrl = `file:${join(directory, "mirror.db")}`;
  const mirror = createClient({ url: mirrorUrl });
  const database = await openAmbientDatabase(`file:${join(directory, "ambient.db")}`);
  try {
    await mirror.execute(
      `CREATE TABLE wa_messages (
        account_id TEXT, chat_id TEXT, message_id TEXT, timestamp INTEGER, data_json TEXT
      )`,
    );
    const rows = [
      // Historical group row: the mirror recorded the group id as the sender —
      // the true author was never synced. Must import unattributed.
      {
        messageId: "m-1",
        kind: "text",
        text: "the checkout button crashes",
        sender: { id: "group-1", mode: "pn" },
        fromMe: false,
        context: { mentions: ["dev@lid"] },
      },
      {
        messageId: "m-2",
        kind: "text",
        text: "on it",
        sender: { id: "me@s.whatsapp.net", mode: "pn" },
        fromMe: true,
        context: { quoted: { from: "reporter@lid", id: "m-1" } },
      },
      {
        messageId: "m-3",
        kind: "image",
        sender: { id: "group-1", mode: "pn" },
        fromMe: false,
        media: { ref: "media-ref-1", mimetype: "image/jpeg", caption: "crash screenshot" },
      },
      {
        messageId: "m-4",
        kind: "unsupported",
        sender: { id: "group-1", mode: "pn" },
        fromMe: false,
      },
    ];
    for (const [index, row] of rows.entries()) {
      await mirror.execute({
        sql: "INSERT INTO wa_messages VALUES (?, ?, ?, ?, ?)",
        args: [
          "main",
          "group-1",
          row.messageId,
          1752573600 + index,
          JSON.stringify({ ...row, chatId: "group-1", timestamp: 1752573600 + index }),
        ],
      });
    }

    const first = await importChatHistory({
      mirrorUrl,
      mirrorAccountId: "main",
      chatId: "group-1",
      sink: database.repositories.observations,
    });
    expect(first).toEqual({ scanned: 4, imported: 3, deduplicated: 0, skippedUnsupported: 1 });

    const retained = await database.repositories.observations.forConversation("group-1");
    expect(retained).toHaveLength(3);
    const byMessageId = new Map(
      retained.map((observation) => {
        const payload = payloadSchema.parse(observation.payload);
        return [payload.messageId, payload] as const;
      }),
    );
    // The group id is never presented as a person; the own JID survives.
    expect(byMessageId.get("m-1")?.sender).toBeUndefined();
    expect(byMessageId.get("m-1")?.context?.mentions).toEqual(["dev@lid"]);
    expect(byMessageId.get("m-2")?.sender?.id).toBe("me@s.whatsapp.net");
    expect(byMessageId.get("m-2")?.context?.quoted).toEqual({ from: "reporter@lid", id: "m-1" });
    expect(byMessageId.get("m-3")?.media).toEqual({
      ref: "media-ref-1",
      mimetype: "image/jpeg",
      caption: "crash screenshot",
    });
    // Evidence only, never speaker work.
    expect(await database.repositories.inbox.pending("group-1")).toEqual([]);

    const again = await importChatHistory({
      mirrorUrl,
      mirrorAccountId: "main",
      chatId: "group-1",
      sink: database.repositories.observations,
    });
    expect(again).toEqual({ scanned: 4, imported: 0, deduplicated: 3, skippedUnsupported: 1 });
  } finally {
    mirror.close();
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
