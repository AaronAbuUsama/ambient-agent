import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type GitHubIngressStatus =
  | "received"
  | "unsupported"
  | "uncorrelated"
  | "dispatched"
  | "uncertain"
  | "failed";

export interface GitHubIngressRecord {
  readonly deliveryId: string;
  readonly eventName: string;
  readonly repository?: string;
  readonly chatId?: string;
  readonly ambience?: string;
  readonly dispatchId?: string;
  readonly status: GitHubIngressStatus;
  readonly error?: string;
  readonly receivedAt: string;
  readonly settledAt?: string;
}

interface GitHubIngressRow {
  delivery_id: string;
  event_name: string;
  repository: string | null;
  chat_id: string | null;
  ambience: string | null;
  dispatch_id: string | null;
  status: GitHubIngressStatus;
  error: string | null;
  received_at: string;
  settled_at: string | null;
}

const hydrate = (row: GitHubIngressRow): GitHubIngressRecord => ({
  deliveryId: row.delivery_id,
  eventName: row.event_name,
  ...(row.repository ? { repository: row.repository } : {}),
  ...(row.chat_id ? { chatId: row.chat_id } : {}),
  ...(row.ambience ? { ambience: row.ambience } : {}),
  ...(row.dispatch_id ? { dispatchId: row.dispatch_id } : {}),
  status: row.status,
  ...(row.error ? { error: row.error } : {}),
  receivedAt: row.received_at,
  ...(row.settled_at ? { settledAt: row.settled_at } : {}),
});

export interface GitHubIngressStore {
  claim(deliveryId: string, eventName: string, receivedAt: string): boolean;
  settle(
    deliveryId: string,
    update: {
      readonly status: Exclude<GitHubIngressStatus, "received">;
      readonly repository?: string;
      readonly chatId?: string;
      readonly ambience?: string;
      readonly dispatchId?: string;
      readonly error?: string;
      readonly settledAt: string;
    },
  ): void;
  markUncertain(deliveryId: string, error: string, settledAt: string): GitHubIngressRecord;
  get(deliveryId: string): GitHubIngressRecord | undefined;
  list(): readonly GitHubIngressRecord[];
  close(): void;
}

export const createGitHubIngressStore = (databasePath: string): GitHubIngressStore => {
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE IF NOT EXISTS github_ingress_deliveries (
      delivery_id TEXT PRIMARY KEY,
      event_name TEXT NOT NULL,
      repository TEXT,
      chat_id TEXT,
      ambience TEXT,
      dispatch_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('received', 'unsupported', 'uncorrelated', 'dispatched', 'uncertain', 'failed')),
      error TEXT,
      received_at TEXT NOT NULL,
      settled_at TEXT
    ) STRICT
  `);

  const claimStatement = database.prepare(`
    INSERT OR IGNORE INTO github_ingress_deliveries
      (delivery_id, event_name, status, received_at)
    VALUES (?, ?, 'received', ?)
  `);
  const settleStatement = database.prepare(`
    UPDATE github_ingress_deliveries
       SET status = ?, repository = ?, chat_id = ?, ambience = ?, dispatch_id = ?, error = ?, settled_at = ?
     WHERE delivery_id = ?
  `);
  const getStatement = database.prepare(`
    SELECT delivery_id, event_name, repository, chat_id, ambience, dispatch_id,
           status, error, received_at, settled_at
      FROM github_ingress_deliveries
     WHERE delivery_id = ?
  `);
  const markUncertainStatement = database.prepare(`
    UPDATE github_ingress_deliveries
       SET status = 'uncertain', error = ?, settled_at = ?
     WHERE delivery_id = ? AND status = 'received'
  `);
  const listStatement = database.prepare(`
    SELECT delivery_id, event_name, repository, chat_id, ambience, dispatch_id,
           status, error, received_at, settled_at
      FROM github_ingress_deliveries
     ORDER BY received_at, delivery_id
  `);

  return {
    claim: (deliveryId, eventName, receivedAt) =>
      claimStatement.run(deliveryId, eventName, receivedAt).changes === 1,
    settle: (deliveryId, update) => {
      const result = settleStatement.run(
        update.status,
        update.repository ?? null,
        update.chatId ?? null,
        update.ambience ?? null,
        update.dispatchId ?? null,
        update.error ?? null,
        update.settledAt,
        deliveryId,
      );
      if (result.changes !== 1) throw new Error(`Unknown GitHub delivery ${deliveryId}`);
    },
    markUncertain: (deliveryId, error, settledAt) => {
      markUncertainStatement.run(error, settledAt, deliveryId);
      const row = getStatement.get(deliveryId) as GitHubIngressRow | undefined;
      if (!row) throw new Error(`Unknown GitHub delivery ${deliveryId}`);
      return hydrate(row);
    },
    get: (deliveryId) => {
      const row = getStatement.get(deliveryId) as GitHubIngressRow | undefined;
      return row ? hydrate(row) : undefined;
    },
    list: () => (listStatement.all() as unknown as GitHubIngressRow[]).map(hydrate),
    close: () => database.close(),
  };
};
