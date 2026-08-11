import { expect, test } from "bun:test";
import type { ChatRecord, ClientChatMessages, WhatsAppClient } from "whatsappd";
import { HistoryBackfill } from "./history-backfill";

const pageSize = 25;

/**
 * A Client that answers only what the walk touches, over a scripted mirror.
 *
 * @remarks
 * Pages land on a later turn of the microtask queue, exactly as the real
 * Client's do, so a walk that forgets to wait for one shows up here as a walk
 * that reads the same page forever rather than as a passing test.
 */
function fakeClient(stored: Record<string, number>): {
  client: WhatsAppClient;
  reads: () => number;
  held: () => Record<string, number>;
  notifyChats: () => void;
} {
  const held: Record<string, number> = {};
  const older: Record<string, ClientChatMessages["older"]> = {};
  const listeners = { messages: new Set<() => void>(), chats: new Set<() => void>() };
  let reads = 0;

  for (const chatId of Object.keys(stored)) {
    held[chatId] = 0;
    older[chatId] = "stored";
  }

  const view = (chatId: string): ClientChatMessages => ({
    chatId,
    messages: Array.from({ length: held[chatId] ?? 0 }, (_, index) => ({
      messageId: `${chatId}:${index}`,
    })) as unknown as ClientChatMessages["messages"],
    outgoing: [],
    older: older[chatId] ?? "stored",
  });

  // Copied, as the real Client copies: a listener unsubscribes from inside its
  // own callback, and iterating the live set would then skip the next one.
  const notify = () => {
    for (const listener of Array.from(listeners.messages)) listener();
  };

  const client = {
    chats: {
      list: (): readonly ChatRecord[] =>
        Object.keys(stored).map((chatId) => ({ chatId }) as ChatRecord),
      subscribe: (listener: () => void) => {
        listeners.chats.add(listener);
        return () => listeners.chats.delete(listener);
      },
    },
    messages: {
      get: view,
      subscribe: (listener: () => void) => {
        listeners.messages.add(listener);
        return () => listeners.messages.delete(listener);
      },
      older: (chatId: string) => {
        if ((older[chatId] ?? "stored") !== "stored") return;
        reads += 1;
        older[chatId] = "loading";
        notify();
        queueMicrotask(() => {
          const total = stored[chatId] ?? 0;
          held[chatId] = Math.min(total, (held[chatId] ?? 0) + pageSize);
          older[chatId] = (held[chatId] ?? 0) < total ? "stored" : "exhausted";
          notify();
        });
      },
    },
  } as unknown as WhatsAppClient;

  const notifyChats = () => {
    for (const listener of Array.from(listeners.chats)) listener();
  };

  return { client, reads: () => reads, held: () => ({ ...held }), notifyChats };
}

/** Drain the microtask queue — no wall clock, so no timing to tune. */
async function turns(count: number): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) await Promise.resolve();
}

/** Run until the walk says it has finished a pass, or fail loudly. */
async function settled(walk: HistoryBackfill, expectedChats?: number): Promise<void> {
  for (let turn = 0; turn < 10_000; turn += 1) {
    if (
      (walk.progress.state === "complete" ||
        walk.progress.state === "capped" ||
        walk.progress.state === "stalled") &&
      (expectedChats === undefined || walk.progress.total === expectedChats)
    ) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(`the walk never settled: ${JSON.stringify(walk.progress)}`);
}

test("every chat is pulled in by default until the mirror has no more", async () => {
  const mirror = fakeClient({ alice: 60, bob: 10, carol: 0 });
  const walk = new HistoryBackfill(() => {});
  walk.start(mirror.client);
  await settled(walk);

  expect(mirror.held()).toEqual({ alice: 60, bob: 10, carol: 0 });
  expect(walk.progress).toMatchObject({ state: "complete", done: 3, total: 3, messages: 70 });
  walk.stop();
});

test("the budget stops the walk inside one chat, not only between chats", async () => {
  // The account that needs a cap is the one whose first chat is enormous.
  const mirror = fakeClient({ huge: 400, bob: 10 });
  const walk = new HistoryBackfill(() => {}, 50);
  walk.start(mirror.client);
  await settled(walk);

  expect(walk.progress.state).toBe("capped");
  expect(mirror.held().huge).toBe(50);
  expect(mirror.held().bob).toBe(0);
  walk.stop();
});

test("a deployment limit must align with the local storage page size", () => {
  expect(() => new HistoryBackfill(() => {}, 1)).toThrow(
    "history backfill limit must be a positive multiple of 25",
  );
});

test("stopping mid-walk parks it and reads nothing further", async () => {
  const mirror = fakeClient({ alice: 500 });
  const walk = new HistoryBackfill(() => {});
  walk.start(mirror.client);
  await turns(4);
  walk.stop();
  const atStop = mirror.reads();
  await turns(200);

  expect(mirror.reads()).toBe(atStop);
  expect(walk.progress.state).toBe("idle");
});

test("a chat appearing later is picked up by the next pass", async () => {
  const stored: Record<string, number> = { alice: 10 };
  const mirror = fakeClient(stored);
  const walk = new HistoryBackfill(() => {});
  walk.start(mirror.client);
  await settled(walk);
  expect(walk.progress.messages).toBe(10);

  // The mirror learns about a chat after the first pass has already parked.
  stored.bob = 30;
  mirror.notifyChats();
  expect(walk.progress.state).toBe("running");
  const progress = await walk.wait();

  expect(mirror.held()).toEqual({ alice: 10, bob: 30 });
  expect(progress).toMatchObject({ state: "complete", done: 2, total: 2, messages: 40 });
  walk.stop();
  expect(walk.progress.state).toBe("idle");
});

test("an update to a known chat does not trigger another account-wide pass", async () => {
  const mirror = fakeClient({ alice: 30 });
  const walk = new HistoryBackfill(() => {});
  walk.start(mirror.client);
  await settled(walk);
  const completedReads = mirror.reads();

  mirror.notifyChats();
  await turns(20);

  expect(mirror.reads()).toBe(completedReads);
  walk.stop();
});
