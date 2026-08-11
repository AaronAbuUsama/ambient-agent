import type { WhatsAppClient } from "whatsappd";

/** What the background walk has managed so far. */
export interface BackfillProgress {
  /** Chats whose stored history is fully in memory. */
  readonly done: number;
  /** Chats the mirror knows about. */
  readonly total: number;
  /** Messages retained across every chat. */
  readonly messages: number;
  readonly state: "idle" | "running" | "complete" | "capped";
}

export const idleBackfill: BackfillProgress = {
  done: 0,
  total: 0,
  messages: 0,
  state: "idle",
};

/**
 * How many messages the walk may pull into memory.
 *
 * @remarks
 * The Client never evicts: every page read stays in its retention map for as
 * long as the Client lives, and pre-reading every chat means pre-reading the
 * whole mirror. A cap is what keeps a five-year account from turning "open the
 * app" into "load five years of messages". Past it the walk stops and `o` goes
 * back to being the way further, which is exactly what it is for.
 */
const defaultLimit = 20_000;

/**
 * Read every chat's stored history into memory, newest chat first.
 *
 * @remarks
 * `messages.older()` reads the *local mirror*, never WhatsApp — so this is a
 * disk walk, not a network one, and the only reason it is not instant is that
 * the Client pages it 25 rows at a time with no way to ask for more. Doing it
 * up front is what removes `o` from the common path: by the time a human opens
 * a chat, its history is already there.
 *
 * Strictly serial, one page in flight across the whole account. The chat a
 * human is actually looking at pages itself from the panel and overtakes this
 * walk naturally, because `older()` is per-chat — so the walk never needs to
 * know which chat is on screen, and never competes with it for more than one
 * read.
 */
export class Backfill {
  readonly #limit: number;
  readonly #notify: () => void;

  #progress: BackfillProgress = idleBackfill;
  #stopped = true;
  #wake: (() => void) | undefined;

  constructor(
    notify: () => void,
    limit = Number(process.env.WHATSAPP_BACKFILL_LIMIT) || defaultLimit,
  ) {
    this.#notify = notify;
    this.#limit = limit;
  }

  get progress(): BackfillProgress {
    return this.#progress;
  }

  start(client: WhatsAppClient): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    void this.#walk(client);
  }

  stop(): void {
    this.#stopped = true;
    this.#wake?.();
    this.#wake = undefined;
    this.#report(idleBackfill);
  }

  async #walk(client: WhatsAppClient): Promise<void> {
    while (!this.#stopped) {
      // Newest first, which is `chats.list()`'s own order: the chats most
      // likely to be opened are the ones worth having ready.
      const chats = client.chats.list();
      let done = 0;
      let held = 0;
      let capped = false;

      for (const chat of chats) {
        if (this.#stopped) return;
        // Reading a chat's view registers it, so live messages for it land in
        // memory from here on rather than being dropped as un-followed. That is
        // the same thing this walk exists to achieve, one chat earlier.
        // The budget is what is left after every chat already walked, and it
        // binds *inside* one chat too: the account that needs a cap is usually
        // the one with a single enormous chat at the top of the list.
        const room = this.#limit - held;
        if (client.messages.get(chat.chatId).older === "stored") {
          capped = (await this.#drain(client, chat.chatId, room)) || capped;
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
        state: capped ? "capped" : "complete",
      });
      // Park. A chat appearing is the only thing that creates work a finished
      // pass did not already do; `stop()` wakes this to end the loop.
      await this.#chatsChanged(client);
    }
  }

  /**
   * Page one chat back until the mirror has no more, or the budget is spent.
   *
   * @param room - Messages this chat may still add before the walk must stop.
   *
   * @returns Whether it stopped on the budget rather than on the mirror.
   */
  async #drain(client: WhatsAppClient, chatId: string, room: number): Promise<boolean> {
    while (!this.#stopped) {
      const before = client.messages.get(chatId);
      if (before.older !== "stored") return false;
      if (before.messages.length >= room) return true;

      client.messages.older(chatId);
      // `older()` is a no-op on a Client that has stopped following, and says
      // so by leaving the state alone. Nothing will land, so nothing to await.
      if (client.messages.get(chatId).older !== "loading") return false;

      await this.#landed(client, chatId);
      // A read that failed puts the state back to `stored` holding what it
      // held, so retrying here would hammer a store that just said no. The next
      // pass is the retry.
      if (client.messages.get(chatId).messages.length === before.messages.length) return false;
    }
    return false;
  }

  /**
   * Wait for one chat's in-flight page to land, fail, or be ended.
   *
   * @remarks
   * A Client that closes mid-read ends it and notifies, so the subscription
   * covers that on its own. `stop()` is the one wake-up no notification can
   * deliver, which is why the resolver is parked on {@link Backfill.stop}'s
   * reach as well.
   */
  async #landed(client: WhatsAppClient, chatId: string): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      this.#wake = undefined;
      resolve();
    };
    const unsubscribe = client.messages.subscribe(() => {
      if (client.messages.get(chatId).older !== "loading") finish();
    });
    this.#wake = finish;
    // It may have landed between `older()` and this subscription.
    if (client.messages.get(chatId).older !== "loading") finish();
    try {
      await promise;
    } finally {
      unsubscribe();
    }
  }

  /** Park until a chat appears, or the walk is stopped. */
  async #chatsChanged(client: WhatsAppClient): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      this.#wake = undefined;
      resolve();
    };
    const unsubscribe = client.chats.subscribe(finish);
    this.#wake = finish;
    try {
      await promise;
    } finally {
      unsubscribe();
    }
  }

  #report(next: BackfillProgress): void {
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
  }
}
