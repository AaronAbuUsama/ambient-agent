import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type { ConversationWindow } from "../coalescer/events.ts";
import type { WhatsAppWindowInput } from "../inputs.ts";
import { whatsappWindowInput } from "../inputs.ts";
import { decodeIncoming, decodeUpdate, type InboxEventRow } from "./managed-chat-inbox.ts";

export type ScribeBackfillMode = "catching_up" | "live" | "failed" | "disabled";
export type ScribeBackfillPhase = "snapshot" | "tail";

export interface ScribeBackfillState {
  readonly chatId: string;
  readonly mode: ScribeBackfillMode;
  readonly phase: ScribeBackfillPhase;
  readonly snapshotHighWater?: number;
  readonly snapshotUnknownTime?: number;
  readonly snapshotOccurredAt?: number;
  readonly snapshotSequence?: number;
  readonly afterSequence: number;
  readonly runId?: string;
  readonly lastError?: string;
}

interface StateRow {
  chat_id: string;
  mode: ScribeBackfillMode;
  phase: ScribeBackfillPhase;
  snapshot_high_water: number | null;
  snapshot_unknown_time: number | null;
  snapshot_occurred_at_ms: number | null;
  snapshot_sequence: number | null;
  after_sequence: number;
  run_id: string | null;
  last_error: string | null;
}

interface ArchiveRow extends InboxEventRow {
  archive_sequence: number;
}

export interface ScribeBackfillPage {
  readonly throughSequence: number;
  readonly archiveEventCount: number;
  readonly receiptCount: number;
  readonly input?: WhatsAppWindowInput;
  readonly snapshotCursor?: {
    readonly unknownTime: number;
    readonly occurredAt: number;
    readonly sequence: number;
  };
}

export interface ScribeBackfillStore {
  get(chatId: string): ScribeBackfillState | undefined;
  states(): readonly ScribeBackfillState[];
  admit(chatId: string, runId?: string): { readonly admitted: boolean; readonly runId?: string };
  retry(chatId: string, runId?: string): { readonly admitted: boolean; readonly runId?: string };
  setRunId(chatId: string, runId: string): void;
  disable(chatId: string): void;
  captureSnapshot(chatId: string): ScribeBackfillState | undefined;
  nextPage(chatId: string, limit?: number): ScribeBackfillPage | undefined;
  checkpoint(chatId: string, page: ScribeBackfillPage): void;
  handoff(chatId: string): boolean;
  fail(chatId: string, errorCode: string): void;
  liveSlice(input: WhatsAppWindowInput): WhatsAppWindowInput | undefined;
  close(): void;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS scribe_backfills (
    chat_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL CHECK (mode IN ('catching_up','live','failed','disabled')),
    phase TEXT NOT NULL CHECK (phase IN ('snapshot','tail')),
    snapshot_high_water INTEGER,
    snapshot_unknown_time INTEGER,
    snapshot_occurred_at_ms INTEGER,
    snapshot_sequence INTEGER,
    after_sequence INTEGER NOT NULL DEFAULT 0,
    run_id TEXT,
    last_error TEXT,
    updated_at_ms INTEGER NOT NULL
  ) STRICT;
`;

const hydrate = (row: StateRow): ScribeBackfillState => ({
  chatId: row.chat_id,
  mode: row.mode,
  phase: row.phase,
  ...(row.snapshot_high_water === null ? {} : { snapshotHighWater: row.snapshot_high_water }),
  ...(row.snapshot_unknown_time === null ? {} : { snapshotUnknownTime: row.snapshot_unknown_time }),
  ...(row.snapshot_occurred_at_ms === null ? {} : { snapshotOccurredAt: row.snapshot_occurred_at_ms }),
  ...(row.snapshot_sequence === null ? {} : { snapshotSequence: row.snapshot_sequence }),
  afterSequence: row.after_sequence,
  ...(row.run_id === null ? {} : { runId: row.run_id }),
  ...(row.last_error === null ? {} : { lastError: row.last_error }),
});

export const createScribeBackfillStore = (databasePath: string, now: () => number = Date.now): ScribeBackfillStore => {
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
  database.exec(SCHEMA);
  const select = database.prepare("SELECT * FROM scribe_backfills WHERE chat_id = ?");
  const get = (chatId: string): ScribeBackfillState | undefined => {
    const row = select.get(chatId) as unknown as StateRow | undefined;
    return row === undefined ? undefined : hydrate(row);
  };
  const transaction = <T>(work: () => T): T => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      database.exec("COMMIT");
      return result;
    } catch (cause) {
      database.exec("ROLLBACK");
      throw cause;
    }
  };
  const begin = (chatId: string, retry: boolean, requestedRunId?: string) => transaction(() => {
    const current = get(chatId);
    if (current !== undefined && !(retry && (current.mode === "failed" || current.mode === "disabled"))) {
      return { admitted: false } as const;
    }
    const runId = requestedRunId ?? randomUUID();
    if (current === undefined) {
      database.prepare(`INSERT INTO scribe_backfills
        (chat_id, mode, phase, after_sequence, run_id, updated_at_ms) VALUES (?, 'catching_up', 'snapshot', 0, ?, ?)`)
        .run(chatId, runId, now());
    } else {
      database.prepare("UPDATE scribe_backfills SET mode = 'catching_up', run_id = ?, last_error = NULL, updated_at_ms = ? WHERE chat_id = ?")
        .run(runId, now(), chatId);
    }
    return { admitted: true, runId } as const;
  });
  const rowsFor = (state: ScribeBackfillState, limit: number): ArchiveRow[] => {
    if (state.phase === "snapshot") {
      if (state.snapshotHighWater === undefined) return [];
      return database.prepare(`SELECT rowid AS archive_sequence, * FROM conversation_events
        WHERE chat_id = ? AND rowid <= ? AND (? IS NULL OR
          (CASE WHEN occurred_at_ms = 0 THEN 1 ELSE 0 END, occurred_at_ms, rowid) > (?, ?, ?))
        ORDER BY CASE WHEN occurred_at_ms = 0 THEN 1 ELSE 0 END, occurred_at_ms, rowid LIMIT ?`)
        .all(state.chatId, state.snapshotHighWater, state.snapshotSequence ?? null,
          state.snapshotUnknownTime ?? null, state.snapshotOccurredAt ?? null, state.snapshotSequence ?? null, limit) as unknown as ArchiveRow[];
    }
    return database.prepare(`SELECT rowid AS archive_sequence, * FROM conversation_events
      WHERE chat_id = ? AND rowid > ? ORDER BY rowid LIMIT ?`)
      .all(state.chatId, state.afterSequence, limit) as unknown as ArchiveRow[];
  };
  const pageOf = (chatId: string, rows: ArchiveRow[]): ScribeBackfillPage | undefined => {
    if (rows.length === 0) return undefined;
    const visible = rows.filter((row) => row.kind !== "receipt");
    const ordered = visible.map((row) => row.kind === "arrival"
      ? { message: decodeIncoming(row), update: undefined }
      : { message: undefined, update: decodeUpdate(row) });
    const last = rows.at(-1)!;
    const window: ConversationWindow = {
      id: `scribe-backfill:${chatId}:${last.archive_sequence}`,
      chatId,
      messages: ordered.flatMap(({ message }) => message === undefined ? [] : [message]),
      updates: ordered.flatMap(({ update }) => update === undefined ? [] : [update]),
      eventOrder: ordered.map(({ message, update }) => (message ?? update!).id),
      reason: "capacity",
    };
    return {
      throughSequence: last.archive_sequence,
      archiveEventCount: rows.length,
      receiptCount: rows.length - visible.length,
      ...(visible.length === 0 ? {} : { input: whatsappWindowInput(window) }),
      snapshotCursor: {
        unknownTime: last.occurred_at_ms === 0 ? 1 : 0,
        occurredAt: last.occurred_at_ms,
        sequence: last.archive_sequence,
      },
    };
  };
  return {
    get,
    states: () => (database.prepare("SELECT * FROM scribe_backfills ORDER BY chat_id").all() as unknown as StateRow[]).map(hydrate),
    admit: (chatId, runId) => begin(chatId, false, runId),
    retry: (chatId, runId) => begin(chatId, true, runId),
    setRunId: (chatId, runId) => {
      database.prepare("UPDATE scribe_backfills SET run_id = ?, updated_at_ms = ? WHERE chat_id = ? AND mode = 'catching_up'").run(runId, now(), chatId);
    },
    disable: (chatId) => transaction(() => {
      database.prepare(`UPDATE scribe_backfills SET
        after_sequence = CASE WHEN mode = 'live' THEN COALESCE((SELECT MAX(rowid) FROM conversation_events WHERE chat_id = ?), 0) ELSE after_sequence END,
        mode = 'disabled', run_id = NULL, updated_at_ms = ? WHERE chat_id = ?`).run(chatId, now(), chatId);
    }),
    captureSnapshot: (chatId) => transaction(() => {
      database.prepare(`UPDATE scribe_backfills SET snapshot_high_water =
        (SELECT COALESCE(MAX(rowid), 0) FROM conversation_events WHERE chat_id = ?), updated_at_ms = ?
        WHERE chat_id = ? AND mode = 'catching_up' AND snapshot_high_water IS NULL`).run(chatId, now(), chatId);
      return get(chatId);
    }),
    nextPage: (chatId, limit = 50) => {
      const state = get(chatId);
      if (state === undefined || state.mode !== "catching_up") return undefined;
      return pageOf(chatId, rowsFor(state, Math.max(1, Math.min(limit, 50))));
    },
    checkpoint: (chatId, page) => transaction(() => {
      const state = get(chatId);
      if (state?.mode !== "catching_up") return;
      if (state.phase === "snapshot") {
        const cursor = page.snapshotCursor!;
        database.prepare(`UPDATE scribe_backfills SET snapshot_unknown_time = ?, snapshot_occurred_at_ms = ?,
          snapshot_sequence = ?, updated_at_ms = ? WHERE chat_id = ? AND mode = 'catching_up'`)
          .run(cursor.unknownTime, cursor.occurredAt, cursor.sequence, now(), chatId);
      } else {
        database.prepare("UPDATE scribe_backfills SET after_sequence = ?, updated_at_ms = ? WHERE chat_id = ? AND mode = 'catching_up'")
          .run(page.throughSequence, now(), chatId);
      }
    }),
    handoff: (chatId) => transaction(() => {
      const state = get(chatId);
      if (state?.mode !== "catching_up" || state.snapshotHighWater === undefined) return false;
      if (state.phase === "snapshot") {
        database.prepare("UPDATE scribe_backfills SET phase = 'tail', after_sequence = snapshot_high_water, updated_at_ms = ? WHERE chat_id = ? AND mode = 'catching_up'")
          .run(now(), chatId);
        return false;
      }
      const newer = database.prepare("SELECT rowid FROM conversation_events WHERE chat_id = ? AND rowid > ? ORDER BY rowid LIMIT 1")
        .get(chatId, state.afterSequence);
      if (newer !== undefined) return false;
      const changed = database.prepare("UPDATE scribe_backfills SET mode = 'live', run_id = NULL, last_error = NULL, updated_at_ms = ? WHERE chat_id = ? AND mode = 'catching_up'")
        .run(now(), chatId).changes;
      return changed === 1;
    }),
    fail: (chatId, errorCode) => transaction(() => {
      database.prepare("UPDATE scribe_backfills SET mode = 'failed', run_id = NULL, last_error = ?, updated_at_ms = ? WHERE chat_id = ? AND mode = 'catching_up'")
        .run(errorCode.slice(0, 200), now(), chatId);
    }),
    liveSlice: (input) => transaction(() => {
      const state = get(input.chatId);
      if (state === undefined) return input;
      if (state.mode !== "live") return undefined;
      const ids = [...input.messages.map((message) => `arrival:${input.chatId}:${message.id}`), ...input.updates.map((update) => update.id)];
      if (ids.length === 0) return undefined;
      const placeholders = ids.map(() => "?").join(",");
      const rows = database.prepare(`SELECT event_id, rowid AS archive_sequence FROM conversation_events WHERE event_id IN (${placeholders})`)
        .all(...ids) as unknown as Array<{ event_id: string; archive_sequence: number }>;
      const keep = new Set(rows.filter((row) => row.archive_sequence > state.afterSequence).map((row) => row.event_id));
      const messages = input.messages.filter((message) => keep.has(`arrival:${input.chatId}:${message.id}`));
      const updates = input.updates.filter((update) => keep.has(update.id));
      if (messages.length + updates.length === 0) return undefined;
      const retainedIds = new Set([...messages.map((message) => message.id), ...updates.map((update) => update.id)]);
      return { ...input, messages, updates, ...(input.eventOrder === undefined ? {} : { eventOrder: input.eventOrder.filter((id) => retainedIds.has(id)) }) };
    }),
    close: () => database.close(),
  };
};
