import type { ClientChatMessages, WhatsAppClient } from "whatsappd";

/** What the local-mirror history backfill has managed so far. */
export interface HistoryBackfillProgress {
  /** Chats whose stored history is fully in memory. */
  readonly done: number;
  /** Chats the mirror knows about. */
  readonly total: number;
  /** Messages retained across every chat. */
  readonly messages: number;
  readonly state: "idle" | "running" | "complete" | "capped" | "stalled";
}

export const idleHistoryBackfill: HistoryBackfillProgress = {
  done: 0,
  total: 0,
  messages: 0,
  state: "idle",
};

type DrainOutcome = "exhausted" | "capped" | "stalled";
type Subscribe = (listener: () => void) => () => void;
const storedPageSize = 25;

function isHistoryBackfillTerminal(
  progress: HistoryBackfillProgress,
): progress is HistoryBackfillProgress & { readonly state: "complete" | "capped" | "stalled" } {
  return (
    progress.state === "complete" || progress.state === "capped" || progress.state === "stalled"
  );
}

/**
 * Read every chat's retained history from the local mirror, newest chat first.
 *
 * @remarks
 * `messages.older()` reads the *local mirror*, never WhatsApp — so this is a
 * disk walk, not a network one. The Client pages 25 rows at a time and has no
 * bulk-read API, so Ambient performs the walk explicitly. Loading the complete
 * mirror is the default because the Memory Analyst needs all locally retained
 * evidence, not only recent messages.
 *
 * Strictly serial, with one page in flight across the whole account. An
 * optional limit is a deployment safety valve; undefined means no limit.
 */
export class HistoryBackfill {
  readonly #limit: number | undefined;
  readonly #notify: () => void;
  readonly #listeners = new Set<() => void>();

  #progress: HistoryBackfillProgress = idleHistoryBackfill;
  #stopped = true;
  #wake: (() => void) | undefined;

  constructor(notify: () => void, limit?: number) {
    if (
      limit !== undefined &&
      (!Number.isInteger(limit) || limit <= 0 || limit % storedPageSize !== 0)
    ) {
      throw new Error(`history backfill limit must be a positive multiple of ${storedPageSize}`);
    }
    this.#notify = notify;
    this.#limit = limit;
  }

  get progress(): HistoryBackfillProgress {
    return this.#progress;
  }

  start(client: WhatsAppClient): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#report({ ...this.#progress, state: "running" });
    void this.#walk(client);
  }

  stop(): void {
    this.#stopped = true;
    this.#wake?.();
    this.#wake = undefined;
    this.#report(idleHistoryBackfill);
  }

  /**
   * Wait for the current pass to complete or stop with an explicit limitation.
   */
  async wait(signal?: AbortSignal): Promise<HistoryBackfillProgress> {
    if (this.#stopped) throw new Error("history backfill is not running");
    if (isHistoryBackfillTerminal(this.#progress)) return this.#progress;
    if (signal?.aborted) throw signal.reason;

    return new Promise<HistoryBackfillProgress>((resolve, reject) => {
      let unsubscribe = () => {};
      const cleanup = () => {
        unsubscribe();
        signal?.removeEventListener("abort", aborted);
      };
      const aborted = () => {
        cleanup();
        reject(signal?.reason);
      };
      const changed = () => {
        if (isHistoryBackfillTerminal(this.#progress)) {
          cleanup();
          resolve(this.#progress);
        } else if (this.#stopped) {
          cleanup();
          reject(new Error("history backfill stopped before completion"));
        }
      };

      this.#listeners.add(changed);
      unsubscribe = () => this.#listeners.delete(changed);
      signal?.addEventListener("abort", aborted, { once: true });
      changed();
    });
  }

  async #walk(client: WhatsAppClient): Promise<void> {
    while (!this.#stopped) {
      // Newest first, which is `chats.list()`'s own order: the chats most
      // likely to be opened are the ones worth having ready.
      const chats = client.chats.list();
      let done = 0;
      let held = 0;
      let capped = false;
      let stalled = false;

      for (const chat of chats) {
        if (this.#stopped) return;
        // Reading a chat's view registers it, so live messages for it land in
        // memory from here on rather than being dropped as un-followed. That is
        // the same thing this walk exists to achieve, one chat earlier.
        // The budget is what is left after every chat already walked, and it
        // binds *inside* one chat too: the account that needs a cap is usually
        // the one with a single enormous chat at the top of the list.
        const room =
          this.#limit === undefined ? Number.POSITIVE_INFINITY : Math.max(0, this.#limit - held);
        if (client.messages.get(chat.chatId).older === "stored") {
          const outcome = await this.#drain(client, chat.chatId, room);
          capped = outcome === "capped" || capped;
          stalled = outcome === "stalled" || stalled;
        }
        if (this.#stopped) return;

        const view = client.messages.get(chat.chatId);
        held += view.messages.length;
        if (view.older === "exhausted") done += 1;
        this.#report({ done, total: chats.length, messages: held, state: "running" });
      }

      this.#report({
        done,
        total: chats.length,
        messages: held,
        state: stalled ? "stalled" : capped ? "capped" : "complete",
      });
      // Park. A newly discovered chat is the only thing that creates work a
      // finished pass did not already do; ordinary chat metadata changes must
      // not trigger another account-wide scan.
      await this.#newChat(client, new Set(chats.map((chat) => chat.chatId)));
    }
  }

  /**
   * Page one chat back until the mirror has no more, or the budget is spent.
   *
   * @param room - Messages this chat may still add before the walk must stop.
   *
   * @returns Why this chat stopped paging.
   */
  async #drain(client: WhatsAppClient, chatId: string, room: number): Promise<DrainOutcome> {
    while (!this.#stopped) {
      const before = client.messages.get(chatId);
      if (before.older !== "stored") return "exhausted";
      if (before.messages.length >= room) return "capped";

      client.messages.older(chatId);
      // `older()` is a no-op on a Client that has stopped following, and says
      // so by leaving the state alone. Nothing will land, so nothing to await.
      const started = client.messages.get(chatId);
      if (started.older !== "loading") {
        return started.older === "exhausted" ? "exhausted" : "stalled";
      }

      const after = await this.#landed(client, chatId);
      if (!after) return "stalled";
      // A read that failed puts the state back to `stored` holding what it
      // held, so retrying here would hammer a store that just said no.
      if (after.older === "exhausted") return "exhausted";
      if (after.messages.length === before.messages.length) return "stalled";
    }
    return "stalled";
  }

  /**
   * Wait for one chat's in-flight page to land, fail, or be ended.
   *
   * @remarks
   * A Client that closes mid-read ends it and notifies, so the subscription
   * covers that on its own. `stop()` is the one wake-up no notification can
   * deliver, which is why the resolver is parked on {@link HistoryBackfill.stop}'s
   * reach as well.
   */
  async #landed(client: WhatsAppClient, chatId: string): Promise<ClientChatMessages | undefined> {
    return this.#waitForChange(
      (listener) => client.messages.subscribe(listener),
      () => {
        const view = client.messages.get(chatId);
        return view.older === "loading" ? undefined : view;
      },
    );
  }

  /** Park until a previously unknown chat appears, or the walk is stopped. */
  async #newChat(client: WhatsAppClient, knownChatIds: ReadonlySet<string>): Promise<void> {
    await this.#waitForChange(
      (listener) => client.chats.subscribe(listener),
      () => {
        const appeared = client.chats.list().some((chat) => !knownChatIds.has(chat.chatId));
        if (!appeared) return;

        // Invalidate the previous terminal result before the next pass starts so
        // a waiter cannot mistake it for a complete view containing the new chat.
        this.#report({ ...this.#progress, state: "running" });
        return true;
      },
    );
  }

  async #waitForChange<T>(subscribe: Subscribe, read: () => T | undefined): Promise<T | undefined> {
    const { promise, resolve } = Promise.withResolvers<T | undefined>();
    let settled = false;
    const changed = () => {
      if (settled) return;
      const value = read();
      if (value === undefined) return;
      settled = true;
      this.#wake = undefined;
      resolve(value);
    };
    const unsubscribe = subscribe(changed);
    this.#wake = () => {
      if (settled) return;
      settled = true;
      this.#wake = undefined;
      resolve(undefined);
    };
    // The condition may have changed before the subscription was installed.
    changed();
    try {
      return await promise;
    } finally {
      unsubscribe();
    }
  }

  #report(next: HistoryBackfillProgress): void {
    const current = this.#progress;
    if (
      current.done === next.done &&
      current.total === next.total &&
      current.messages === next.messages &&
      current.state === next.state
    ) {
      return;
    }
    this.#progress = next;
    this.#notify();
    for (const listener of Array.from(this.#listeners)) listener();
  }
}
