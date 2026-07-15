import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type IssueOperationStatus = "attempting" | "completed" | "uncertain" | "failed";

export interface IssueOperationRecord {
  readonly operationId: string;
  readonly kind: "create-issue";
  readonly repository: string;
  readonly status: IssueOperationStatus;
  readonly issueNumber?: number;
  readonly error?: string;
  readonly startedAt: string;
  readonly settledAt?: string;
}

interface IssueOperationRow {
  operation_id: string;
  kind: "create-issue";
  repository: string;
  status: IssueOperationStatus;
  issue_number: number | null;
  error: string | null;
  started_at: string;
  settled_at: string | null;
}

const hydrate = (row: IssueOperationRow): IssueOperationRecord => ({
  operationId: row.operation_id,
  kind: row.kind,
  repository: row.repository,
  status: row.status,
  ...(row.issue_number === null ? {} : { issueNumber: row.issue_number }),
  ...(row.error === null ? {} : { error: row.error }),
  startedAt: row.started_at,
  ...(row.settled_at === null ? {} : { settledAt: row.settled_at }),
});

export interface IssueOperationStore {
  begin(input: {
    readonly operationId: string;
    readonly repository: string;
    readonly startedAt: string;
  }): IssueOperationRecord;
  complete(operationId: string, issueNumber: number, settledAt: string): IssueOperationRecord;
  uncertain(operationId: string, error: string, settledAt: string): IssueOperationRecord;
  fail(operationId: string, error: string, settledAt: string): IssueOperationRecord;
  get(operationId: string): IssueOperationRecord | undefined;
  list(): readonly IssueOperationRecord[];
  close(): void;
}

export const createIssueOperationStore = (databasePath: string): IssueOperationStore => {
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS github_issue_operations (
      operation_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind = 'create-issue'),
      repository TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('attempting', 'completed', 'uncertain', 'failed')),
      issue_number INTEGER,
      error TEXT,
      started_at TEXT NOT NULL,
      settled_at TEXT
    ) STRICT
  `);
  const insert = database.prepare(`
    INSERT INTO github_issue_operations
      (operation_id, kind, repository, status, started_at)
    VALUES (?, 'create-issue', ?, 'attempting', ?)
  `);
  const settle = database.prepare(`
    UPDATE github_issue_operations
       SET status = ?, issue_number = ?, error = ?, settled_at = ?
     WHERE operation_id = ? AND status = 'attempting'
  `);
  const select = database.prepare("SELECT * FROM github_issue_operations WHERE operation_id = ?");
  const list = database.prepare("SELECT * FROM github_issue_operations ORDER BY started_at, operation_id");
  const get = (operationId: string): IssueOperationRecord | undefined => {
    const row = select.get(operationId) as IssueOperationRow | undefined;
    return row === undefined ? undefined : hydrate(row);
  };
  const update = (
    operationId: string,
    status: Exclude<IssueOperationStatus, "attempting">,
    issueNumber: number | null,
    error: string | null,
    settledAt: string,
  ): IssueOperationRecord => {
    const result = settle.run(status, issueNumber, error, settledAt, operationId);
    if (result.changes !== 1) throw new Error(`Issue operation ${operationId} is missing or already settled.`);
    return get(operationId)!;
  };
  return {
    begin: ({ operationId, repository, startedAt }) => {
      insert.run(operationId, repository, startedAt);
      return get(operationId)!;
    },
    complete: (operationId, issueNumber, settledAt) => update(operationId, "completed", issueNumber, null, settledAt),
    uncertain: (operationId, error, settledAt) => update(operationId, "uncertain", null, error, settledAt),
    fail: (operationId, error, settledAt) => update(operationId, "failed", null, error, settledAt),
    get,
    list: () => (list.all() as unknown as IssueOperationRow[]).map(hydrate),
    close: () => database.close(),
  };
};
