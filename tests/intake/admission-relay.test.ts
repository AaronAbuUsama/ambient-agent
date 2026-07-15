import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sqlite } from "@flue/runtime/node";
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { ConversationWindow } from "../../src/coalescer/events.ts";
import {
  admitWindow,
  createFlueAdmissionEvidenceSource,
  reconcileUncertainAdmission,
} from "../../src/intake/admission-relay.ts";
import { createConversationArchive } from "../../src/intake/conversation-archive.ts";
import { conversationArrival } from "../../src/intake/conversation-event.ts";
import { createManagedChatInbox } from "../../src/intake/managed-chat-inbox.ts";
import type { IncomingMessage } from "whatsappd";

const CHAT = "managed-admission@g.us";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "ambient-admission-relay-"));
  roots.push(root);
  const archive = createConversationArchive(join(root, "application.sqlite"));
  let windowSequence = 0;
  let attemptSequence = 0;
  const inbox = createManagedChatInbox(archive, {
    allowed: () => true,
    createId: () => `window-${++windowSequence}`,
    createAttemptId: () => `attempt-${++attemptSequence}`,
    now: () => 1_000,
  });
  const arrival = {
    id: "message-1",
    chatId: CHAT,
    from: "alice@s.whatsapp.net",
    pushName: "Alice",
    fromMe: false,
    timestamp: 1_000,
    live: true,
    isGroup: true,
    kind: "text",
    text: "admit this once",
    reply: async () => ({ id: "reply", chatId: CHAT, fromMe: true }),
  } as IncomingMessage;
  inbox.recorder.append(conversationArrival(arrival));
  const window = inbox.createWindow({
    chatId: CHAT,
    messages: inbox.unwindowed(),
    reason: "debounce",
  });
  return { archive, inbox, window };
};

describe("Admission Relay", () => {
  it("records dispatching before Flue and retains the returned receipt", async () => {
    const { archive, inbox, window } = fixture();
    const observed = [] as unknown[];

    await admitWindow(inbox, window, async () => {
      observed.push(inbox.admission(window.id));
      return { dispatchId: "dispatch-1", acceptedAt: "2026-07-15T01:00:00.000Z" };
    });

    expect(observed).toEqual([{ status: "dispatching", windowId: "window-1", attemptId: "attempt-1" }]);
    expect(inbox.admission(window.id)).toEqual({
      status: "admitted",
      windowId: "window-1",
      dispatchId: "dispatch-1",
      acceptedAt: "2026-07-15T01:00:00.000Z",
    });
    expect(inbox.pendingWindows()).toEqual([]);
    archive.close();
  });

  it("leaves a Window pending when dispatching state cannot be recorded", async () => {
    const { archive, inbox, window } = fixture();
    archive.transaction(({ database }) => {
      database.exec(`
        CREATE TRIGGER fail_before_dispatch
        BEFORE UPDATE OF status ON managed_chat_admissions
        WHEN NEW.status = 'dispatching'
        BEGIN SELECT RAISE(ABORT, 'injected before-dispatch failure'); END;
      `);
    });
    let calls = 0;

    await expect(
      admitWindow(inbox, window, async () => {
        calls += 1;
        return { dispatchId: "must-not-exist", acceptedAt: "2026-07-15T01:00:00.000Z" };
      }),
    ).rejects.toThrow("injected before-dispatch failure");

    expect(calls).toBe(0);
    expect(inbox.admission(window.id)).toEqual({ status: "pending", windowId: "window-1" });
    expect(inbox.pendingWindows()).toEqual([window]);
    archive.close();
  });

  it("marks a rejected dispatch Uncertain and never offers it for automatic replay", async () => {
    const { archive, inbox, window } = fixture();

    await expect(
      admitWindow(inbox, window, async () => {
        throw new Error("provider outcome unknown");
      }),
    ).rejects.toThrow("provider outcome unknown");

    expect(inbox.admission(window.id)).toEqual({
      status: "uncertain",
      windowId: "window-1",
      attemptId: "attempt-1",
      reason: "provider outcome unknown",
    });
    expect(inbox.pendingWindows()).toEqual([]);
    archive.close();
  });

  it("marks a lost post-acceptance receipt Uncertain without a second dispatch", async () => {
    const { archive, inbox, window } = fixture();
    archive.transaction(({ database }) => {
      database.exec(`
        CREATE TRIGGER fail_after_acceptance
        BEFORE UPDATE OF status ON managed_chat_admissions
        WHEN NEW.status = 'admitted'
        BEGIN SELECT RAISE(ABORT, 'injected receipt-write failure'); END;
      `);
    });
    let calls = 0;

    await expect(
      admitWindow(inbox, window, async () => {
        calls += 1;
        return { dispatchId: "dispatch-accepted", acceptedAt: "2026-07-15T01:01:00.000Z" };
      }),
    ).rejects.toThrow("injected receipt-write failure");
    expect(inbox.admission(window.id)).toEqual({
      status: "uncertain",
      windowId: "window-1",
      attemptId: "attempt-1",
      reason:
        "Flue returned dispatch dispatch-accepted, but its admission receipt could not be recorded: injected receipt-write failure",
    });
    archive.close();

    const reopenedArchive = createConversationArchive(join(roots.at(-1)!, "application.sqlite"));
    const reopened = createManagedChatInbox(reopenedArchive, { allowed: () => true });
    expect(calls).toBe(1);
    expect(reopened.admission(window.id)).toEqual({
      status: "uncertain",
      windowId: "window-1",
      attemptId: "attempt-1",
      reason:
        "Flue returned dispatch dispatch-accepted, but its admission receipt could not be recorded: injected receipt-write failure",
    });
    expect(reopened.pendingWindows()).toEqual([]);
    reopenedArchive.close();
  });

  it("converts a crash-interrupted dispatching attempt to Uncertain on restart", () => {
    const { archive, inbox, window } = fixture();
    expect(inbox.beginAdmission(window.id)).toEqual({
      status: "dispatching",
      windowId: "window-1",
      attemptId: "attempt-1",
    });
    archive.close();

    const reopenedArchive = createConversationArchive(join(roots.at(-1)!, "application.sqlite"));
    const reopened = createManagedChatInbox(reopenedArchive, { allowed: () => true });
    expect(reopened.admission(window.id)).toEqual({
      status: "uncertain",
      windowId: "window-1",
      attemptId: "attempt-1",
      reason: "process restarted after dispatch began",
    });
    expect(reopened.pendingWindows()).toEqual([]);
    reopenedArchive.close();
  });

  it("uses positive canonical evidence to reconcile Uncertain, while absence proves nothing", async () => {
    const { archive, inbox, window } = fixture();
    await expect(
      admitWindow(inbox, window, async () => {
        throw new Error("connection reset after send");
      }),
    ).rejects.toThrow("connection reset after send");

    await expect(reconcileUncertainAdmission(inbox, window.id, { find: async () => undefined })).resolves.toEqual({
      status: "unresolved",
      admission: inbox.admission(window.id),
    });
    expect(inbox.admission(window.id)?.status).toBe("uncertain");

    await expect(
      reconcileUncertainAdmission(inbox, window.id, {
        find: async () => ({ dispatchId: "dispatch-observed", acceptedAt: "2026-07-15T01:02:00.000Z" }),
      }),
    ).resolves.toEqual({
      status: "admitted",
      admission: {
        status: "admitted",
        windowId: "window-1",
        dispatchId: "dispatch-observed",
        acceptedAt: "2026-07-15T01:02:00.000Z",
      },
    });
    archive.close();
  });

  it("reads the exact receipt from the file-backed Flue canonical store through its public adapter", async () => {
    const root = mkdtempSync(join(tmpdir(), "ambient-flue-evidence-"));
    roots.push(root);
    const databasePath = join(root, "flue.sqlite");
    const adapter = sqlite(databasePath);
    await adapter.migrate?.();
    const stores = await adapter.connect();
    const store = stores.conversationStreamStore;
    const window: ConversationWindow = {
      id: "window-canonical",
      chatId: CHAT,
      reason: "mention",
      messages: [],
    };
    const path = `agents/ambience/${CHAT}`;
    await store.createStream(path, { agentName: "ambience", instanceId: CHAT });
    const producer = await store.acquireProducer(path, "test-producer");
    await store.append({
      path,
      producerId: producer.producerId,
      producerEpoch: producer.producerEpoch,
      incarnation: producer.incarnation,
      producerSequence: producer.nextProducerSequence,
      records: [
        {
          v: 1,
          id: "record-dispatch",
          type: "signal",
          conversationId: "conversation-1",
          harness: "default",
          session: "default",
          timestamp: "2026-07-15T01:03:00.000Z",
          dispatchId: "dispatch-canonical",
          messageId: "dispatch_dispatch-canonical",
          parentId: null,
          signalType: "dispatch_input",
          tagName: "dispatch",
          content: JSON.stringify({
            type: "whatsapp.window",
            windowId: window.id,
            chatId: window.chatId,
          }),
          attributes: {
            agent: "ambience",
            id: CHAT,
            session: "default",
            dispatchId: "dispatch-canonical",
            acceptedAt: "2026-07-15T01:03:00.000Z",
          },
        },
      ],
    });
    await adapter.close?.();

    await expect(createFlueAdmissionEvidenceSource(databasePath).find(window)).resolves.toEqual({
      dispatchId: "dispatch-canonical",
      acceptedAt: "2026-07-15T01:03:00.000Z",
    });
  });
});
