import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { createConversationArchive } from "../../packages/engine/src/intake/conversation-archive.ts";
import { createScribeBackfillStore } from "../../packages/engine/src/intake/scribe-backfill.ts";
import type { ConversationEvent } from "../../packages/engine/src/intake/conversation-event.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const arrival = (chatId: string, id: string, occurredAt: number): ConversationEvent => ({
  id: `arrival:${chatId}:${id}`, kind: "arrival", providerMessageId: id, chatId,
  senderId: "person@s.whatsapp.net", direction: "inbound", occurredAt,
  payload: { live: false, isGroup: true, messageKind: "text", text: id },
});

describe("Scribe backfill", () => {
  it("paginates raw rows, skips receipt-only prompts, and hands off once", () => {
    const root = mkdtempSync(join(tmpdir(), "scribe-backfill-")); roots.push(root);
    const path = join(root, "application.sqlite");
    const archive = createConversationArchive(path);
    archive.append(arrival("chat", "late", 20));
    archive.append(arrival("chat", "early", 10));
    archive.append({ id: "receipt-1", kind: "receipt", providerMessageId: "early", chatId: "chat", direction: "inbound", occurredAt: 30, payload: { status: "read" } });
    archive.close();
    const store = createScribeBackfillStore(path, () => 1);
    expect(store.admit("chat", "run-1")).toEqual({ admitted: true, runId: "run-1" });
    expect(store.admit("chat", "run-2")).toEqual({ admitted: false });
    store.captureSnapshot("chat");
    const first = store.nextPage("chat", 2)!;
    expect(first.input?.messages.map(({ id }) => id)).toEqual(["early", "late"]);
    expect(first.input?.eventOrder).toEqual(["early", "late"]);
    store.checkpoint("chat", first);
    const receipts = store.nextPage("chat", 2)!;
    expect(receipts.input).toBeUndefined();
    expect(receipts.receiptCount).toBe(1);
    store.checkpoint("chat", receipts);
    expect(store.nextPage("chat")).toBeUndefined();
    expect(store.handoff("chat")).toBe(false);
    expect(store.handoff("chat")).toBe(true);
    expect(store.handoff("chat")).toBe(false);
    store.close();
  });

  it("filters a buffered live Window at the durable cutoff", () => {
    const root = mkdtempSync(join(tmpdir(), "scribe-backfill-")); roots.push(root);
    const path = join(root, "application.sqlite");
    const archive = createConversationArchive(path); archive.append(arrival("chat", "before", 10)); archive.close();
    const store = createScribeBackfillStore(path);
    store.admit("chat", "run"); store.captureSnapshot("chat");
    const page = store.nextPage("chat")!; store.checkpoint("chat", page); store.handoff("chat"); store.handoff("chat");
    const again = createConversationArchive(path); again.append(arrival("chat", "after", 20)); again.close();
    const sliced = store.liveSlice({ type: "whatsapp.window", windowId: "window", chatId: "chat", reason: "capacity",
      messages: [
        { id: "before", chatId: "chat", from: "p", text: "before", timestamp: 10, isGroup: true, fromMe: false, live: true, mentions: [] },
        { id: "after", chatId: "chat", from: "p", text: "after", timestamp: 20, isGroup: true, fromMe: false, live: true, mentions: [] },
      ], updates: [], eventOrder: ["before", "after"] });
    expect(sliced?.messages.map(({ id }) => id)).toEqual(["after"]);
    expect(sliced?.eventOrder).toEqual(["after"]);
    store.close();
  });
});
