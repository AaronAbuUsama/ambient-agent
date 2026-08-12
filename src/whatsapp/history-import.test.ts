import { expect, test } from "vite-plus/test";
import { createClient } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAmbientDatabase } from "../database/database";
import { importChatHistory } from "./history-import";

test("history import maps text messages, dedupes, and never creates Inbox work", async () => {
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
      {
        messageId: "m-1",
        kind: "text",
        text: "hello from the phone",
        sender: { id: "a@s.whatsapp.net", mode: "pn" },
        fromMe: false,
      },
      {
        messageId: "m-2",
        kind: "text",
        text: "hello back",
        sender: { id: "me@s.whatsapp.net", mode: "pn" },
        fromMe: true,
      },
      {
        messageId: "m-3",
        kind: "image",
        sender: { id: "a@s.whatsapp.net", mode: "pn" },
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
    expect(first).toEqual({ scanned: 3, imported: 2, deduplicated: 0, skippedNonText: 1 });

    const retained = await database.repositories.observations.forConversation("group-1");
    expect(retained).toHaveLength(2);
    // fromMe history is retained as evidence too — both sides of a chat matter.
    expect(retained.map(({ occurredAt }) => occurredAt.slice(0, 4))).toEqual(["2025", "2025"]);
    // Evidence only, never speaker work.
    expect(await database.repositories.inbox.pending("group-1")).toEqual([]);

    const again = await importChatHistory({
      mirrorUrl,
      mirrorAccountId: "main",
      chatId: "group-1",
      sink: database.repositories.observations,
    });
    expect(again).toEqual({ scanned: 3, imported: 0, deduplicated: 2, skippedNonText: 1 });
  } finally {
    mirror.close();
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
