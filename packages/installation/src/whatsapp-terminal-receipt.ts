import { DatabaseSync } from "node:sqlite";

import type { WhatsAppTerminalReceipt } from "./runtime-health.ts";

interface TerminalReceiptRow {
  readonly correlation_id: string;
  readonly invocation_id: string;
  readonly phase: WhatsAppTerminalReceipt["phase"];
  readonly reason: string;
  readonly observed_at: string;
}

const receiptFromRow = (row: TerminalReceiptRow): WhatsAppTerminalReceipt => ({
  correlationId: row.correlation_id,
  invocationId: row.invocation_id,
  phase: row.phase,
  reason: row.reason,
  observedAt: row.observed_at,
});

const withDatabase = <T>(path: string, operation: (database: DatabaseSync) => T): T => {
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS whatsapp_terminal_receipts (
        correlation_id TEXT PRIMARY KEY,
        invocation_id TEXT NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('logged_out', 'suspended')),
        reason TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        acknowledged_at TEXT,
        announced_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_whatsapp_terminal_receipt
        ON whatsapp_terminal_receipts ((announced_at IS NULL))
        WHERE announced_at IS NULL;
    `);
    return operation(database);
  } finally {
    database.close();
  }
};

const selectPending = (database: DatabaseSync): WhatsAppTerminalReceipt | undefined => {
  const row = database
    .prepare(
      `SELECT correlation_id, invocation_id, phase, reason, observed_at
       FROM whatsapp_terminal_receipts
       WHERE announced_at IS NULL
       ORDER BY observed_at, correlation_id
       LIMIT 1`,
    )
    .get() as TerminalReceiptRow | undefined;
  return row === undefined ? undefined : receiptFromRow(row);
};

export const pendingWhatsAppTerminalReceipt = (path: string): WhatsAppTerminalReceipt | undefined =>
  withDatabase(path, selectPending);

/**
 * Keep one pending incident across service-manager restart churn. A second process racing this
 * insert reads the row that won the partial unique index and uses its correlation id too.
 */
export const persistWhatsAppTerminalReceipt = (
  path: string,
  receipt: WhatsAppTerminalReceipt,
): WhatsAppTerminalReceipt =>
  withDatabase(path, (database) => {
    database
      .prepare(
        `INSERT OR IGNORE INTO whatsapp_terminal_receipts
           (correlation_id, invocation_id, phase, reason, observed_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(receipt.correlationId, receipt.invocationId, receipt.phase, receipt.reason, receipt.observedAt);
    const pending = selectPending(database);
    if (pending === undefined) throw new Error("The terminal WhatsApp receipt was not persisted.");
    return pending;
  });

export const acknowledgeWhatsAppTerminalReceipt = (path: string, correlationId: string): void =>
  withDatabase(path, (database) => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const row = database
        .prepare(
          `SELECT acknowledged_at
           FROM whatsapp_terminal_receipts
           WHERE correlation_id = ? AND announced_at IS NULL`,
        )
        .get(correlationId) as { readonly acknowledged_at: string | null } | undefined;
      if (row === undefined) {
        throw new Error(`The pending WhatsApp terminal receipt ${correlationId} could not be acknowledged.`);
      }
      if (row.acknowledged_at === null) {
        const result = database
          .prepare(
            `UPDATE whatsapp_terminal_receipts
             SET acknowledged_at = ?
             WHERE correlation_id = ? AND acknowledged_at IS NULL AND announced_at IS NULL`,
          )
          .run(new Date().toISOString(), correlationId);
        if (result.changes !== 1) {
          throw new Error(`The pending WhatsApp terminal receipt ${correlationId} could not be acknowledged.`);
        }
      }
      database.exec("COMMIT");
    } catch (cause) {
      database.exec("ROLLBACK");
      throw cause;
    }
  });

/** Complete the tiny durable outbox only after the correlated online record has been emitted. */
export const markWhatsAppTerminalReceiptAnnounced = (path: string, correlationId: string): void =>
  withDatabase(path, (database) => {
    const result = database
      .prepare(
        `UPDATE whatsapp_terminal_receipts
         SET announced_at = ?
         WHERE correlation_id = ? AND acknowledged_at IS NOT NULL AND announced_at IS NULL`,
      )
      .run(new Date().toISOString(), correlationId);
    if (result.changes !== 1) {
      throw new Error(`The acknowledged WhatsApp terminal receipt ${correlationId} could not be marked announced.`);
    }
  });
