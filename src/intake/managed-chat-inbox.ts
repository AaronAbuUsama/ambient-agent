import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { ConversationWindow, ConversationWindowDraft, FireReason, IncomingMessage } from "../coalescer/events.js";
import { Effect, Layer } from "effect";
import { WindowStore, WindowStoreError } from "../coalescer/ports.js";
import type { ConversationArchive } from "./conversation-archive.js";
import type { ConversationArrival, ConversationArrivalPayload, ConversationEvent } from "./conversation-event.js";

interface InboxEventRow {
  event_id: string;
  provider_message_id: string;
  chat_id: string;
  sender_id: string;
  sender_name: string | null;
  direction: "inbound" | "outbound";
  occurred_at_ms: number;
  payload_json: string;
}

interface WindowRow {
  window_id: string;
  chat_id: string;
  reason: FireReason;
}

interface AssignmentRow {
  event_id: string;
  window_id: string | null;
}

interface AdmissionRow {
  window_id: string;
  status: "pending" | "dispatching" | "admitted" | "uncertain";
  attempt_id: string | null;
  dispatch_id: string | null;
  accepted_at: string | null;
  reason: string | null;
}

export type WindowAdmission =
  | { readonly status: "pending"; readonly windowId: string }
  | { readonly status: "dispatching"; readonly windowId: string; readonly attemptId: string }
  | {
      readonly status: "admitted";
      readonly windowId: string;
      readonly dispatchId: string;
      readonly acceptedAt: string;
    }
  | {
      readonly status: "uncertain";
      readonly windowId: string;
      readonly attemptId: string;
      readonly reason: string;
    };

export interface WindowAdmissionReceipt {
  readonly dispatchId: string;
  readonly acceptedAt: string;
}

export interface ManagedChatRecorder {
  append(event: ConversationEvent): boolean;
}

export interface ManagedChatInbox {
  readonly recorder: ManagedChatRecorder;
  unwindowed(): readonly IncomingMessage[];
  pendingArrival(chatId: string, messageId: string): IncomingMessage | undefined;
  pendingWindows(): readonly ConversationWindow[];
  window(windowId: string): ConversationWindow | undefined;
  createWindow(draft: ConversationWindowDraft): ConversationWindow;
  admission(windowId: string): WindowAdmission | undefined;
  admissions(status?: WindowAdmission["status"]): readonly WindowAdmission[];
  beginAdmission(windowId: string): Extract<WindowAdmission, { readonly status: "dispatching" }>;
  markAdmitted(windowId: string, attemptId: string, receipt: WindowAdmissionReceipt): void;
  markUncertain(windowId: string, attemptId: string, reason: string): void;
  reconcileAdmission(windowId: string, receipt: WindowAdmissionReceipt): WindowAdmission;
}

export interface CreateManagedChatInboxOptions {
  readonly allowed: (chatId: string, isGroup: boolean) => boolean;
  readonly createId?: () => string;
  readonly createAttemptId?: () => string;
  readonly now?: () => number;
}

const eventIdOf = (message: IncomingMessage): string => `arrival:${message.chatId}:${message.id}`;

const decodeIncoming = (row: InboxEventRow): IncomingMessage => {
  const payload = JSON.parse(row.payload_json) as ConversationArrivalPayload;
  return {
    id: row.provider_message_id,
    chatId: row.chat_id,
    from: row.sender_id,
    ...(row.sender_name === null ? {} : { pushName: row.sender_name }),
    text: payload.text,
    timestamp: row.occurred_at_ms,
    isGroup: payload.isGroup,
    fromMe: row.direction === "outbound",
    live: payload.live,
    mentions: payload.context?.mentions ?? [],
    ...(payload.context?.quoted?.from === undefined ? {} : { quotedFrom: payload.context.quoted.from }),
  };
};

const acceptedArrival = (
  event: ConversationEvent,
  allowed: CreateManagedChatInboxOptions["allowed"],
): event is ConversationArrival =>
  event.kind === "arrival" &&
  event.direction === "inbound" &&
  event.payload.live &&
  allowed(event.chatId, event.payload.isGroup);

export const createManagedChatInbox = (
  archive: ConversationArchive,
  options: CreateManagedChatInboxOptions,
): ManagedChatInbox => {
  const createId = options.createId ?? randomUUID;
  const createAttemptId = options.createAttemptId ?? randomUUID;
  const now = options.now ?? Date.now;
  const blockedUntilReopen = archive.transaction(({ database }) => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS managed_chat_windows (
        window_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (reason IN ('debounce', 'maximum-wait', 'capacity', 'mention', 'quote-reply')),
        created_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS managed_chat_windows_created_idx
        ON managed_chat_windows(created_at_ms, window_id);
      CREATE TABLE IF NOT EXISTS managed_chat_inbox (
        inbox_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        chat_id TEXT NOT NULL,
        window_id TEXT,
        accepted_at_ms INTEGER NOT NULL,
        FOREIGN KEY (event_id) REFERENCES conversation_events(event_id),
        FOREIGN KEY (window_id) REFERENCES managed_chat_windows(window_id)
      );
      CREATE INDEX IF NOT EXISTS managed_chat_inbox_pending_idx
        ON managed_chat_inbox(window_id, inbox_sequence);
      CREATE INDEX IF NOT EXISTS managed_chat_inbox_chat_idx
        ON managed_chat_inbox(chat_id, inbox_sequence);
      CREATE TABLE IF NOT EXISTS managed_chat_admissions (
        window_id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('pending', 'dispatching', 'admitted', 'uncertain')),
        attempt_id TEXT,
        dispatch_id TEXT,
        accepted_at TEXT,
        reason TEXT,
        updated_at_ms INTEGER NOT NULL,
        FOREIGN KEY (window_id) REFERENCES managed_chat_windows(window_id),
        CHECK (
          (status = 'pending' AND attempt_id IS NULL AND dispatch_id IS NULL AND accepted_at IS NULL AND reason IS NULL)
          OR (status = 'dispatching' AND attempt_id IS NOT NULL AND dispatch_id IS NULL AND accepted_at IS NULL AND reason IS NULL)
          OR (status = 'admitted' AND attempt_id IS NOT NULL AND dispatch_id IS NOT NULL AND accepted_at IS NOT NULL AND reason IS NULL)
          OR (status = 'uncertain' AND attempt_id IS NOT NULL AND dispatch_id IS NULL AND accepted_at IS NULL AND reason IS NOT NULL)
        )
      );
      CREATE INDEX IF NOT EXISTS managed_chat_admissions_status_idx
        ON managed_chat_admissions(status, updated_at_ms, window_id);
    `);

    database
      .prepare(`
        UPDATE managed_chat_admissions
           SET status = 'uncertain', reason = ?, updated_at_ms = ?
         WHERE status = 'dispatching'
      `)
      .run("process restarted after dispatch began", now());
    database
      .prepare(`
        INSERT INTO managed_chat_admissions
          (window_id, status, attempt_id, reason, updated_at_ms)
        SELECT w.window_id, 'uncertain', 'legacy:' || w.window_id, ?, ?
          FROM managed_chat_windows w
          LEFT JOIN managed_chat_admissions a ON a.window_id = w.window_id
         WHERE a.window_id IS NULL
      `)
      .run("Window predates the admission ledger; prior delivery is unknown", now());
    const rows = database
      .prepare(`
        SELECT DISTINCT w.chat_id
          FROM managed_chat_admissions a
          JOIN managed_chat_windows w ON w.window_id = a.window_id
         WHERE a.status = 'uncertain'
      `)
      .all() as unknown as Array<{ readonly chat_id: string }>;
    return new Set(rows.map(({ chat_id }) => chat_id));
  });

  const selectInbox = (database: DatabaseSync, where: string): readonly InboxEventRow[] =>
    database
      .prepare(`
      SELECT e.event_id, e.provider_message_id, e.chat_id, e.sender_id, e.sender_name,
             e.direction, e.occurred_at_ms, e.payload_json
        FROM managed_chat_inbox i
        JOIN conversation_events e ON e.event_id = i.event_id
       ${where}
       ORDER BY i.inbox_sequence
    `)
      .all() as unknown as InboxEventRow[];

  const readWindow = (database: DatabaseSync, windowId: string): ConversationWindow => {
    const row = database
      .prepare("SELECT window_id, chat_id, reason FROM managed_chat_windows WHERE window_id = ?")
      .get(windowId) as unknown as WindowRow | undefined;
    if (row === undefined) throw new Error(`Managed Chat Window ${windowId} does not exist.`);
    const messages = database
      .prepare(`
      SELECT e.event_id, e.provider_message_id, e.chat_id, e.sender_id, e.sender_name,
             e.direction, e.occurred_at_ms, e.payload_json
        FROM managed_chat_inbox i
        JOIN conversation_events e ON e.event_id = i.event_id
       WHERE i.window_id = ?
       ORDER BY i.inbox_sequence
    `)
      .all(windowId) as unknown as InboxEventRow[];
    return { id: row.window_id, chatId: row.chat_id, reason: row.reason, messages: messages.map(decodeIncoming) };
  };

  const decodeAdmission = (row: AdmissionRow): WindowAdmission => {
    switch (row.status) {
      case "pending":
        return { status: "pending", windowId: row.window_id };
      case "dispatching":
        return { status: "dispatching", windowId: row.window_id, attemptId: row.attempt_id! };
      case "admitted":
        return {
          status: "admitted",
          windowId: row.window_id,
          dispatchId: row.dispatch_id!,
          acceptedAt: row.accepted_at!,
        };
      case "uncertain":
        return {
          status: "uncertain",
          windowId: row.window_id,
          attemptId: row.attempt_id!,
          reason: row.reason!,
        };
    }
  };

  const readAdmission = (database: DatabaseSync, windowId: string): WindowAdmission | undefined => {
    const row = database
      .prepare(`
        SELECT window_id, status, attempt_id, dispatch_id, accepted_at, reason
          FROM managed_chat_admissions
         WHERE window_id = ?
      `)
      .get(windowId) as unknown as AdmissionRow | undefined;
    return row === undefined ? undefined : decodeAdmission(row);
  };

  const assertReceipt = (receipt: WindowAdmissionReceipt): void => {
    if (!receipt.dispatchId.trim()) throw new Error("A Flue admission receipt requires a dispatchId.");
    if (!receipt.acceptedAt.trim() || !Number.isFinite(Date.parse(receipt.acceptedAt))) {
      throw new Error("A Flue admission receipt requires a valid acceptedAt timestamp.");
    }
  };

  const transitionFailed = (database: DatabaseSync, windowId: string, target: WindowAdmission["status"]): Error =>
    new Error(
      `Managed Chat Window ${windowId} cannot transition to ${target} from ${readAdmission(database, windowId)?.status ?? "missing"}.`,
    );

  return {
    recorder: {
      append: (event) =>
        archive.transaction((transaction) => {
          const inserted = transaction.append(event);
          if (inserted && acceptedArrival(event, options.allowed)) {
            transaction.database
              .prepare(`
            INSERT INTO managed_chat_inbox (event_id, chat_id, accepted_at_ms)
            VALUES (?, ?, ?)
          `)
              .run(event.id, event.chatId, now());
          }
          return inserted;
        }),
    },
    unwindowed: () =>
      archive.transaction(({ database }) =>
        selectInbox(
          database,
          `WHERE i.window_id IS NULL
             AND NOT EXISTS (
               SELECT 1
                 FROM managed_chat_admissions blocked
                 JOIN managed_chat_windows blocked_window ON blocked_window.window_id = blocked.window_id
                WHERE blocked_window.chat_id = i.chat_id AND blocked.status = 'uncertain'
             )`,
        )
          .map(decodeIncoming)
          .filter(({ chatId }) => !blockedUntilReopen.has(chatId)),
      ),
    pendingArrival: (chatId, messageId) => {
      if (blockedUntilReopen.has(chatId)) return undefined;
      return archive.transaction(({ database }) => {
        const row = database
          .prepare(`
            SELECT e.event_id, e.provider_message_id, e.chat_id, e.sender_id, e.sender_name,
                   e.direction, e.occurred_at_ms, e.payload_json
              FROM managed_chat_inbox i
              JOIN conversation_events e ON e.event_id = i.event_id
             WHERE i.event_id = ? AND i.window_id IS NULL
               AND NOT EXISTS (
                 SELECT 1
                   FROM managed_chat_admissions blocked
                   JOIN managed_chat_windows blocked_window ON blocked_window.window_id = blocked.window_id
                  WHERE blocked_window.chat_id = i.chat_id AND blocked.status = 'uncertain'
               )
          `)
          .get(`arrival:${chatId}:${messageId}`) as unknown as InboxEventRow | undefined;
        return row === undefined ? undefined : decodeIncoming(row);
      });
    },
    pendingWindows: () =>
      archive.transaction(({ database }) => {
        const rows = database
          .prepare(`
            SELECT w.window_id, w.chat_id, w.reason
              FROM managed_chat_windows w
             JOIN managed_chat_inbox i ON i.window_id = w.window_id
              JOIN managed_chat_admissions a ON a.window_id = w.window_id
             WHERE a.status = 'pending'
               AND NOT EXISTS (
                 SELECT 1
                   FROM managed_chat_admissions blocked
                   JOIN managed_chat_windows blocked_window ON blocked_window.window_id = blocked.window_id
                  WHERE blocked_window.chat_id = w.chat_id AND blocked.status = 'uncertain'
               )
             GROUP BY w.rowid
             ORDER BY MIN(i.inbox_sequence), w.rowid
          `)
          .all() as unknown as WindowRow[];
        return rows
          .map(({ window_id }) => readWindow(database, window_id))
          .filter(({ chatId }) => !blockedUntilReopen.has(chatId));
      }),
    window: (windowId) =>
      archive.transaction(({ database }) => {
        const exists = database
          .prepare("SELECT 1 AS present FROM managed_chat_windows WHERE window_id = ?")
          .get(windowId);
        return exists === undefined ? undefined : readWindow(database, windowId);
      }),
    createWindow: (draft) => {
      if (draft.messages.length === 0) throw new Error("A Managed Chat Window must contain at least one arrival.");
      if (draft.messages.some(({ chatId }) => chatId !== draft.chatId)) {
        throw new Error("A Managed Chat Window cannot mix chats.");
      }
      const eventIds = draft.messages.map(eventIdOf);
      return archive.transaction(({ database }) => {
        const selectAssignment = database.prepare(
          "SELECT event_id, window_id FROM managed_chat_inbox WHERE event_id = ?",
        );
        const assignments = eventIds.map(
          (eventId) => selectAssignment.get(eventId) as unknown as AssignmentRow | undefined,
        );
        if (assignments.some((assignment) => assignment === undefined)) {
          throw new Error("A Managed Chat Window may contain only accepted Inbox arrivals.");
        }
        const assigned = new Set(assignments.map((assignment) => assignment!.window_id).filter(Boolean));
        if (assigned.size === 1 && assignments.every((assignment) => assignment!.window_id !== null)) {
          const existing = readWindow(database, [...assigned][0]!);
          const existingEventIds = existing.messages.map(eventIdOf);
          if (
            existingEventIds.length === eventIds.length &&
            existingEventIds.every((id, index) => id === eventIds[index])
          ) {
            return existing;
          }
          throw new Error("A Managed Chat arrival already belongs to a different Window assignment.");
        }
        if (assigned.size > 0) throw new Error("A Managed Chat arrival cannot belong to more than one Window.");

        const oldestPending = database
          .prepare(`
            SELECT event_id FROM managed_chat_inbox
             WHERE chat_id = ? AND window_id IS NULL
             ORDER BY inbox_sequence
             LIMIT ?
          `)
          .all(draft.chatId, eventIds.length) as unknown as Array<{ readonly event_id: string }>;
        if (
          oldestPending.length !== eventIds.length ||
          oldestPending.some(({ event_id }, index) => event_id !== eventIds[index])
        ) {
          throw new Error("A Managed Chat Window must claim the oldest pending arrivals in observed order.");
        }

        const windowId = createId();
        database
          .prepare(`
          INSERT INTO managed_chat_windows (window_id, chat_id, reason, created_at_ms)
          VALUES (?, ?, ?, ?)
        `)
          .run(windowId, draft.chatId, draft.reason, now());
        database
          .prepare(`
            INSERT INTO managed_chat_admissions (window_id, status, updated_at_ms)
            VALUES (?, 'pending', ?)
          `)
          .run(windowId, now());
        const assign = database.prepare(`
          UPDATE managed_chat_inbox SET window_id = ?
           WHERE event_id = ? AND chat_id = ? AND window_id IS NULL
        `);
        for (const eventId of eventIds) {
          const result = assign.run(windowId, eventId, draft.chatId);
          if (result.changes !== 1) throw new Error("Managed Chat Window assignment lost an accepted arrival.");
        }
        return { id: windowId, ...draft };
      });
    },
    admission: (windowId) => archive.transaction(({ database }) => readAdmission(database, windowId)),
    admissions: (status) =>
      archive.transaction(({ database }) => {
        const rows = database
          .prepare(`
            SELECT window_id, status, attempt_id, dispatch_id, accepted_at, reason
              FROM managed_chat_admissions
             WHERE (? IS NULL OR status = ?)
             ORDER BY updated_at_ms, rowid
          `)
          .all(status ?? null, status ?? null) as unknown as AdmissionRow[];
        return rows.map(decodeAdmission);
      }),
    beginAdmission: (windowId) =>
      archive.transaction(({ database }) => {
        const attemptId = createAttemptId();
        const result = database
          .prepare(`
            UPDATE managed_chat_admissions
               SET status = 'dispatching', attempt_id = ?, updated_at_ms = ?
             WHERE window_id = ? AND status = 'pending'
          `)
          .run(attemptId, now(), windowId);
        if (result.changes !== 1) throw transitionFailed(database, windowId, "dispatching");
        return { status: "dispatching", windowId, attemptId };
      }),
    markAdmitted: (windowId, attemptId, receipt) => {
      assertReceipt(receipt);
      archive.transaction(({ database }) => {
        const result = database
          .prepare(`
            UPDATE managed_chat_admissions
               SET status = 'admitted', dispatch_id = ?, accepted_at = ?, updated_at_ms = ?
             WHERE window_id = ? AND status = 'dispatching' AND attempt_id = ?
          `)
          .run(receipt.dispatchId, receipt.acceptedAt, now(), windowId, attemptId);
        if (result.changes !== 1) throw transitionFailed(database, windowId, "admitted");
      });
    },
    markUncertain: (windowId, attemptId, reason) => {
      const normalizedReason = reason.trim();
      if (!normalizedReason) throw new Error("An Uncertain admission requires a reason.");
      const chatId = archive.transaction(({ database }) => {
        const result = database
          .prepare(`
            UPDATE managed_chat_admissions
               SET status = 'uncertain', reason = ?, updated_at_ms = ?
             WHERE window_id = ? AND status = 'dispatching' AND attempt_id = ?
          `)
          .run(normalizedReason, now(), windowId, attemptId);
        if (result.changes !== 1) throw transitionFailed(database, windowId, "uncertain");
        return readWindow(database, windowId).chatId;
      });
      blockedUntilReopen.add(chatId);
    },
    reconcileAdmission: (windowId, receipt) => {
      assertReceipt(receipt);
      return archive.transaction(({ database }) => {
        const result = database
          .prepare(`
            UPDATE managed_chat_admissions
               SET status = 'admitted', dispatch_id = ?, accepted_at = ?, reason = NULL, updated_at_ms = ?
             WHERE window_id = ? AND status = 'uncertain'
          `)
          .run(receipt.dispatchId, receipt.acceptedAt, now(), windowId);
        if (result.changes !== 1) throw transitionFailed(database, windowId, "admitted");
        return readAdmission(database, windowId)!;
      });
    },
  };
};

export const managedChatWindowStore = (inbox: ManagedChatInbox): Layer.Layer<WindowStore, never> =>
  Layer.succeed(WindowStore, {
    pendingWindows: Effect.try({
      try: () => inbox.pendingWindows(),
      catch: (cause) => new WindowStoreError({ cause }),
    }),
    create: (draft) =>
      Effect.try({
        try: () => inbox.createWindow(draft),
        catch: (cause) => new WindowStoreError({ cause }),
      }),
  });
