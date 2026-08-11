import {
  createWhatsAppClient,
  createWhatsAppRuntime,
  type Awaitable,
  type ChatRecord,
  type ClientChatMessages,
  type ContactRecord,
  type CredentialStore,
  type GroupRecord,
  type MessageRef,
  type RuntimeSession,
  type Status,
  type WaIdentity,
  type WhatsAppBackend,
  type WhatsAppClient,
  type WhatsAppDataStore,
  type WhatsAppOperation,
  type WhatsAppRuntime,
} from "whatsappd";
import {
  HistoryBackfill,
  idleHistoryBackfill,
  type HistoryBackfillProgress,
} from "./history-backfill";

/**
 * A backend whose deployment may own a connection to close.
 *
 * @remarks
 * `libsqlBackend()` holds a database handle and answers `close()`; the in-memory
 * grouping used by tests holds nothing and does not. Widening the type here
 * rather than demanding a closable backend is what lets one controller serve both.
 */
export type ClosableBackend = WhatsAppBackend & { close?(): Promise<void> };

/** How this process is attached to the account, independent of WhatsApp's own state. */
export type Attachment = "detached" | "attaching" | "attached" | "detaching";

/**
 * One identity-stable view of the retained account and live session.
 *
 * @remarks
 * {@link Attachment} and {@link WhatsAppSessionSnapshot.status} answer different
 * questions and neither implies the other: a runtime can be `attached` while
 * WhatsApp is `backing_off`, and a `logged_out` status leaves the runtime
 * attached until something stops it. Collapsing them into one enum is what
 * makes a consumer claim a connection it does not have.
 */
export interface WhatsAppSessionSnapshot {
  readonly attachment: Attachment;
  /** WhatsApp's live connection status, or `null` before a session exists. */
  readonly status: Status | null;
  readonly identity: WaIdentity | undefined;
  readonly chats: readonly ChatRecord[];
  readonly groups: readonly GroupRecord[];
  /** The last failure, cleared by the next successful transition. */
  readonly error: string | null;
  /** How far the full local-mirror history walk has got. */
  readonly historyBackfill: HistoryBackfillProgress;
  /**
   * Bumped by every committed client change.
   *
   * @remarks
   * Message pages live per chat behind {@link WhatsAppSessionController.chatMessages}
   * rather than in this snapshot. The counter lets consumers detect committed
   * changes without copying every retained message into each snapshot.
   */
  readonly revision: number;
}

export interface WhatsAppSessionOptions {
  readonly accountId: string;
  /** Undefined means load every message retained in the local mirror. */
  readonly historyBackfillLimit?: number;
  /** Build this deployment's storage. Called once, on the first attach. */
  createBackend(): Awaitable<ClosableBackend>;
  /** Open the live session the runtime will consume. Called on every attach. */
  openSession(credentials: CredentialStore): Awaitable<RuntimeSession>;
  /** Follow WhatsApp's committed accepted-source log with a durable Ambient cursor. */
  acceptedSource?: {
    start(source: WhatsAppDataStore): Promise<void>;
    wake(): Promise<void>;
    stop(): Promise<void>;
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One account's lifecycle, held for the life of Ambient.
 *
 * @remarks
 * A `whatsappd` Runtime consumes an account exactly once — `stopped` latches on
 * the way down — so reconnecting means building a new Runtime and Client over
 * the *same* Backend rather than restarting anything. That asymmetry is the
 * reason this class exists: it keeps the storage that should outlive a
 * connection separate from the two objects that must not.
 */
export class WhatsAppSessionController {
  readonly #options: WhatsAppSessionOptions;
  readonly #listeners = new Set<() => void>();

  #backend: ClosableBackend | null = null;
  #runtime: WhatsAppRuntime | null = null;
  #client: WhatsAppClient | null = null;
  #session: RuntimeSession | null = null;
  #unsubscribe: Array<() => void> = [];

  #attachment: Attachment = "detached";
  #status: Status | null = null;
  #error: string | null = null;
  #revision = 0;
  #snapshot: WhatsAppSessionSnapshot | null = null;
  readonly #historyBackfill: HistoryBackfill;

  /** Serializes attach and detach so two controls cannot interleave one lifecycle. */
  #transition: Promise<unknown> = Promise.resolve();
  #disposed = false;

  constructor(options: WhatsAppSessionOptions) {
    this.#options = options;
    this.#historyBackfill = new HistoryBackfill(
      () => this.#invalidate(),
      options.historyBackfillLimit,
    );
  }

  getSnapshot = (): WhatsAppSessionSnapshot => {
    this.#snapshot ??= {
      attachment: this.#attachment,
      status: this.#status,
      identity: this.#session?.identity?.(),
      chats: this.#client?.chats.list() ?? [],
      groups: this.#client?.groups.list() ?? [],
      error: this.#error,
      historyBackfill: this.#client ? this.#historyBackfill.progress : idleHistoryBackfill,
      revision: this.#revision,
    };
    return this.#snapshot;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** One chat's retained messages, or `null` while no Client is attached. */
  chatMessages(chatId: string): ClientChatMessages | null {
    return this.#client?.messages.get(chatId) ?? null;
  }

  /**
   * Wait for the current full-mirror history pass to reach a terminal state.
   *
   * The Memory Analyst can use this boundary before its first account-wide
   * analysis. A `capped` or `stalled` result is explicit and must not be
   * mistaken for complete history.
   */
  async waitForHistoryBackfill(signal?: AbortSignal): Promise<HistoryBackfillProgress> {
    if (!this.#client) throw new Error("not connected");
    return this.#historyBackfill.wait(signal);
  }

  /** The contact record owning a native address, for display names. */
  resolveContact(nativeId: string): ContactRecord | undefined {
    return this.#client?.contacts.resolve(nativeId);
  }

  /**
   * Claim the account and follow it.
   *
   * @returns The attachment reached, so a caller can report what it did rather
   * than re-reading state that may already have moved on.
   */
  async attach(): Promise<Attachment> {
    return this.#serialize(async (): Promise<Attachment> => {
      if (this.#disposed) throw new Error("session controller disposed");
      if (this.#attachment === "attached") return "attached";

      this.#attachment = "attaching";
      this.#error = null;
      this.#invalidate();

      try {
        this.#backend ??= await this.#options.createBackend();
        const backend = this.#backend;
        await this.#options.acceptedSource?.start(backend.data);
        const runtime = createWhatsAppRuntime({
          accountId: this.#options.accountId,
          backend,
          openSession: async (credentials) => {
            const session = await this.#options.openSession(credentials);
            this.#session = session;
            this.#unsubscribe.push(
              session.subscribe({
                connection: (status) => {
                  this.#status = status;
                  this.#invalidate();
                },
              }),
            );
            return session;
          },
        });
        this.#runtime = runtime;
        this.#unsubscribe.push(runtime.onFrame(() => this.#wakeAcceptedSource()));
        await runtime.start();

        const client = await createWhatsAppClient(runtime);
        this.#client = client;
        this.#follow(client);
        // Load every chat's retained history so account-wide memory analysis
        // can distinguish complete evidence from a partial local view.
        this.#historyBackfill.start(client);

        this.#attachment = "attached";
        this.#invalidate();
        return "attached";
      } catch (error) {
        this.#error = messageOf(error);
        await this.#teardown();
        this.#attachment = "detached";
        this.#invalidate();
        throw error;
      }
    });
  }

  /** Stop following and release the account, keeping credentials for the next attach. */
  async detach(): Promise<Attachment> {
    return this.#serialize(async (): Promise<Attachment> => {
      if (this.#attachment === "detached") return "detached";
      this.#attachment = "detaching";
      this.#invalidate();
      await this.#teardown();
      this.#attachment = "detached";
      this.#status = null;
      this.#invalidate();
      return "detached";
    });
  }

  /** Send a text message through the account's durable operation queue. */
  async sendText(chatId: string, text: string): Promise<WhatsAppOperation<MessageRef>> {
    const client = this.#client;
    if (!client) throw new Error("not connected");
    return client.messages.send.text(chatId, text);
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    await this.detach();
    await this.#serialize(async () => {
      await this.#backend?.close?.();
      this.#backend = null;
      this.#listeners.clear();
    });
  }

  #serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#transition.then(work, work);
    this.#transition = next.catch(() => {});
    return next;
  }

  #follow(client: WhatsAppClient): void {
    const bump = () => this.#invalidate();
    this.#unsubscribe.push(
      client.chats.subscribe(bump),
      client.contacts.subscribe(bump),
      client.groups.subscribe(bump),
      client.messages.subscribe(bump),
      client.account.subscribe(() => {
        const account = client.account.get();
        // A closed Client will never report again; the Runtime behind it is
        // gone, so surface the failure rather than holding a dead attachment.
        if (account.closed && this.#attachment === "attached") {
          this.#error = account.error ? messageOf(account.error) : null;
          this.#attachment = "detaching";
          this.#invalidate();
          void this.detach();
          return;
        }
        this.#invalidate();
      }),
    );
  }

  async #teardown(): Promise<void> {
    this.#historyBackfill.stop();
    for (const unsubscribe of this.#unsubscribe.splice(0)) {
      try {
        unsubscribe();
      } catch {
        // An unsubscribe that throws has already stopped delivering to us.
      }
    }
    await this.#options.acceptedSource?.stop().catch(() => {});
    // Client → Runtime → Backend is the documented close order; the Backend
    // outlives both here so a later attach reuses one database handle.
    await this.#client?.close().catch(() => {});
    await this.#runtime?.stop().catch(() => {});
    this.#client = null;
    this.#runtime = null;
    this.#session = null;
  }

  #invalidate(): void {
    this.#revision += 1;
    this.#snapshot = null;
    // Copied: a listener may unsubscribe or add another while being notified.
    for (const listener of Array.from(this.#listeners)) {
      try {
        listener();
      } catch {
        // A consumer that throws must not fail the session pipeline:
        // `whatsappd` treats a rejected handler as terminal.
      }
    }
  }

  #wakeAcceptedSource(): void {
    const acceptedSource = this.#options.acceptedSource;
    if (!acceptedSource) return;
    void acceptedSource.wake().catch((error: unknown) => {
      if (this.#attachment === "detached" || this.#attachment === "detaching") return;
      this.#error = messageOf(error);
      this.#invalidate();
      void this.detach();
    });
  }
}
