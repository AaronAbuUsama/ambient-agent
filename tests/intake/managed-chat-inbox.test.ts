import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { createConversationArchive } from "../../src/intake/conversation-archive.ts";
import { conversationArrival } from "../../src/intake/conversation-event.ts";
import { createManagedChatInbox } from "../../src/intake/managed-chat-inbox.ts";
import type { IncomingMessage } from "whatsappd";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "ambient-managed-inbox-"));
  roots.push(root);
  return join(root, "application.sqlite");
};

const message = (id: string, overrides: Partial<IncomingMessage> = {}): IncomingMessage =>
  ({
    id,
    chatId: "managed@g.us",
    from: "15551112222@s.whatsapp.net",
    pushName: "Alice",
    fromMe: false,
    timestamp: Number(id.replace(/\D/g, "")) || 1,
    live: true,
    isGroup: true,
    kind: "text",
    text: id,
    reply: async () => ({ id: "reply", chatId: "managed@g.us", fromMe: true }),
    ...overrides,
  }) as IncomingMessage;

describe("Managed Chat Inbox", () => {
  it("atomically archives all facts but accepts only configured live inbound arrivals", () => {
    const archive = createConversationArchive(fixture());
    const inbox = createManagedChatInbox(archive, {
      allowed: (chatId) => chatId === "managed@g.us",
    });

    expect(inbox.recorder.append(conversationArrival(message("m1")))).toBe(true);
    expect(inbox.recorder.append(conversationArrival(message("m2", { chatId: "unmanaged@g.us" })))).toBe(true);
    expect(inbox.recorder.append(conversationArrival(message("m3", { live: false })))).toBe(true);
    expect(inbox.recorder.append(conversationArrival(message("m4", { fromMe: true })))).toBe(true);

    expect(archive.events()).toHaveLength(4);
    expect(inbox.unwindowed().map(({ id }) => id)).toEqual(["m1"]);
    archive.close();
  });

  it("rolls Archive and projection writes back when Inbox acceptance fails", () => {
    const archive = createConversationArchive(fixture());
    const inbox = createManagedChatInbox(archive, { allowed: () => true });
    archive.transaction(({ database }) => {
      database.exec(`
        CREATE TRIGGER fail_managed_inbox
        BEFORE INSERT ON managed_chat_inbox
        BEGIN SELECT RAISE(ABORT, 'injected inbox failure'); END;
      `);
    });

    expect(() => inbox.recorder.append(conversationArrival(message("m1")))).toThrow("injected inbox failure");
    expect(archive.events()).toEqual([]);
    expect(archive.readThread("managed@g.us")).toEqual([]);
    expect(inbox.unwindowed()).toEqual([]);
    archive.close();
  });

  it("leaves every accepted arrival pending when Window creation fails", () => {
    const archive = createConversationArchive(fixture());
    const inbox = createManagedChatInbox(archive, { allowed: () => true });
    inbox.recorder.append(conversationArrival(message("m1")));
    inbox.recorder.append(conversationArrival(message("m2")));
    archive.transaction(({ database }) => {
      database.exec(`
        CREATE TRIGGER fail_managed_window
        BEFORE INSERT ON managed_chat_windows
        BEGIN SELECT RAISE(ABORT, 'injected window failure'); END;
      `);
    });

    expect(() =>
      inbox.createWindow({
        chatId: "managed@g.us",
        messages: inbox.unwindowed(),
        reason: "debounce",
      }),
    ).toThrow("injected window failure");
    expect(inbox.unwindowed().map(({ id }) => id)).toEqual(["m1", "m2"]);
    expect(inbox.pendingWindows()).toEqual([]);
    archive.close();
  });

  it("preserves observed order and stable Window identity across restart", () => {
    const path = fixture();
    const archive = createConversationArchive(path);
    let nextWindow = 0;
    let currentTime = 5_000;
    const inbox = createManagedChatInbox(archive, {
      allowed: () => true,
      createId: () => `window-stable-${++nextWindow}`,
      now: () => currentTime,
    });
    inbox.recorder.append(conversationArrival(message("m1", { timestamp: 3_000 })));
    inbox.recorder.append(conversationArrival(message("m2", { timestamp: 1_000 })));
    inbox.recorder.append(conversationArrival(message("m3", { timestamp: 2_000 })));

    expect(inbox.unwindowed().map(({ id }) => id)).toEqual(["m1", "m2", "m3"]);
    expect(() =>
      inbox.createWindow({
        chatId: "managed@g.us",
        messages: inbox.unwindowed().slice(1, 2),
        reason: "debounce",
      }),
    ).toThrow("must claim the oldest pending arrivals in observed order");
    const window = inbox.createWindow({
      chatId: "managed@g.us",
      messages: inbox.unwindowed().slice(0, 2),
      reason: "capacity",
    });
    expect(window).toMatchObject({ id: "window-stable-1", reason: "capacity" });
    expect(window.messages.map(({ id }) => id)).toEqual(["m1", "m2"]);
    expect(inbox.unwindowed().map(({ id }) => id)).toEqual(["m3"]);
    expect(
      inbox.createWindow({
        chatId: "managed@g.us",
        messages: window.messages,
        reason: "debounce",
      }),
    ).toEqual(window);
    expect(() =>
      inbox.createWindow({
        chatId: "managed@g.us",
        messages: window.messages.slice(0, 1),
        reason: "debounce",
      }),
    ).toThrow("already belongs to a different Window assignment");
    currentTime = 4_000;
    const secondWindow = inbox.createWindow({
      chatId: "managed@g.us",
      messages: inbox.unwindowed(),
      reason: "debounce",
    });
    const windowedIds = inbox.pendingWindows().flatMap(({ messages }) => messages.map(({ id }) => id));
    expect(windowedIds).toEqual(["m1", "m2", "m3"]);
    expect(new Set(windowedIds).size).toBe(3);
    expect(inbox.admission(window.id)).toEqual({ status: "pending", windowId: "window-stable-1" });
    archive.close();

    const reopenedArchive = createConversationArchive(path);
    const reopened = createManagedChatInbox(reopenedArchive, { allowed: () => true });
    expect(reopened.pendingWindows()).toEqual([window, secondWindow]);
    expect(reopened.unwindowed()).toEqual([]);
    reopenedArchive.close();
  });

  it("classifies pre-ledger Windows as Uncertain instead of blindly replaying them", () => {
    const path = fixture();
    const archive = createConversationArchive(path);
    const inbox = createManagedChatInbox(archive, {
      allowed: () => true,
      createId: () => "legacy-window",
    });
    inbox.recorder.append(conversationArrival(message("m1")));
    const window = inbox.createWindow({
      chatId: "managed@g.us",
      messages: inbox.unwindowed(),
      reason: "debounce",
    });
    archive.transaction(({ database }) => database.exec("DROP TABLE managed_chat_admissions"));
    archive.close();

    const reopenedArchive = createConversationArchive(path);
    const reopened = createManagedChatInbox(reopenedArchive, { allowed: () => true });
    expect(reopened.pendingWindows()).toEqual([]);
    expect(reopened.admission(window.id)).toEqual({
      status: "uncertain",
      windowId: "legacy-window",
      attemptId: "legacy:legacy-window",
      reason: "Window predates the admission ledger; prior delivery is unknown",
    });
    reopenedArchive.close();
  });

  it("keeps later same-chat arrivals behind an Uncertain Window across restart", () => {
    const path = fixture();
    const archive = createConversationArchive(path);
    const inbox = createManagedChatInbox(archive, {
      allowed: () => true,
      createId: () => "uncertain-window",
      createAttemptId: () => "uncertain-attempt",
    });
    inbox.recorder.append(conversationArrival(message("m1")));
    const window = inbox.createWindow({
      chatId: "managed@g.us",
      messages: inbox.unwindowed(),
      reason: "debounce",
    });
    const attempt = inbox.beginAdmission(window.id);
    inbox.markUncertain(window.id, attempt.attemptId, "provider outcome unknown");
    inbox.recorder.append(conversationArrival(message("m2")));
    expect(inbox.unwindowed()).toEqual([]);
    expect(inbox.pendingArrival("managed@g.us", "m2")).toBeUndefined();
    archive.close();

    const reopenedArchive = createConversationArchive(path);
    const reopened = createManagedChatInbox(reopenedArchive, { allowed: () => true });
    expect(reopened.unwindowed()).toEqual([]);
    expect(reopened.pendingArrival("managed@g.us", "m2")).toBeUndefined();
    expect(reopened.pendingWindows()).toEqual([]);

    reopened.reconcileAdmission(window.id, {
      dispatchId: "dispatch-observed",
      acceptedAt: "2026-07-15T01:10:00.000Z",
    });
    expect(reopened.unwindowed()).toEqual([]);
    expect(reopened.pendingArrival("managed@g.us", "m2")).toBeUndefined();
    reopenedArchive.close();

    const resumedArchive = createConversationArchive(path);
    const resumed = createManagedChatInbox(resumedArchive, { allowed: () => true });
    expect(resumed.unwindowed().map(({ id }) => id)).toEqual(["m2"]);
    expect(resumed.pendingArrival("managed@g.us", "m2")?.id).toBe("m2");
    resumedArchive.close();
  });
});
