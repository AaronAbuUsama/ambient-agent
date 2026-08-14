import { createClient } from "@libsql/client";
import { sql } from "drizzle-orm";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConversationSpeakerStore, ConversationWorkStore } from "../conversation/contract";
import type { EvaluationWorkStore } from "../evals/contract";
import type { MemoryWorkStore } from "../memory/contract";
import * as schema from "./schema";
import {
  createConversationInboxRepository,
  type ConversationInboxRepository,
} from "./conversation-inbox";
import { createConversationSpeakerStore } from "./conversation-speakers";
import { createConversationWorkStore } from "./conversation-work";
import { createEvaluationRepository, type EvaluationRepository } from "./evaluations";
import { createEvaluationWorkStore } from "./evaluation-work";
import { createIdentityStore, type IdentityStore } from "./identity";
import { createMemoryRepository, type MemoryRepository } from "./memory";
import { createMemoryWorkStore } from "./memory-work";
import {
  createMessageIngestionRepository,
  type MessageIngestionRepository,
} from "./message-ingestion";
import type { MediaDescriptionStore } from "../media/contract";
import { createMediaDescriptionStore } from "./media";
import { createObservationRepository, type ObservationRepository } from "./observations";
import { createRunRepository, type RunRepository } from "./runs";
import { createTaskRepository, type TaskRepository } from "./tasks";

export interface AmbientRepositories {
  readonly identity: IdentityStore;
  readonly observations: ObservationRepository;
  readonly messageIngestion: MessageIngestionRepository;
  readonly inbox: ConversationInboxRepository;
  readonly conversationWork: ConversationWorkStore;
  readonly speakers: ConversationSpeakerStore;
  readonly memory: MemoryRepository;
  readonly memoryWork: MemoryWorkStore;
  readonly mediaDescriptions: MediaDescriptionStore;
  readonly runs: RunRepository;
  readonly tasks: TaskRepository;
  readonly evaluations: EvaluationRepository;
  readonly evaluationWork: EvaluationWorkStore;
}

export interface AmbientDatabase {
  readonly repositories: AmbientRepositories;
  close(): Promise<void>;
}

export type AmbientDatabaseConnection = LibSQLDatabase<typeof schema>;

async function prepareLocalDirectory(url: string): Promise<void> {
  if (!url.startsWith("file:")) return;
  const path = url.slice("file:".length).split(/[?#]/, 1)[0];
  if (!path || path === ":memory:") return;
  await mkdir(dirname(resolve(path)), { recursive: true });
}

function repositories(database: AmbientDatabaseConnection): AmbientRepositories {
  const evaluations = createEvaluationRepository(database);
  return {
    identity: createIdentityStore(database),
    observations: createObservationRepository(database),
    messageIngestion: createMessageIngestionRepository(database),
    inbox: createConversationInboxRepository(database),
    conversationWork: createConversationWorkStore(database),
    speakers: createConversationSpeakerStore(database),
    runs: createRunRepository(database),
    tasks: createTaskRepository(database),
    evaluations,
    evaluationWork: createEvaluationWorkStore(database),
    mediaDescriptions: createMediaDescriptionStore(database),
    memory: createMemoryRepository(database),
    memoryWork: createMemoryWorkStore(database),
  };
}

export async function openAmbientDatabase(url: string): Promise<AmbientDatabase> {
  await prepareLocalDirectory(url);
  const client = createClient({ url });
  const database = drizzle(client, { schema });
  // drizzle-orm/libsql opens a FRESH connection per transaction (and ignores
  // its config argument), so no busy-timeout pragma can reach one: the moment
  // the daemon overlaps ingestion, claims, and mandate resync, two write
  // transactions collide as instant SQLITE_BUSY. SQLite permits one writer
  // anyway — queue our transactions here, where no call site can forget it.
  const transaction = database.transaction.bind(database);
  let tail: Promise<void> = Promise.resolve();
  database.transaction = ((callback: never, config: never) => {
    const run = tail.then(() => transaction(callback, config));
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }) as typeof database.transaction;
  try {
    await database.run(sql`PRAGMA foreign_keys = ON`);
    // WAL is persistent in the file, so drizzle's per-transaction connections
    // inherit it: readers never block the writer, and a crash mid-write is
    // recoverable.
    await database.run(sql`PRAGMA journal_mode = WAL`);
    // The queue above serializes OUR transactions, but plain statements run
    // on the main connection while a transaction holds the write lock on its
    // own connection — with no timeout that is an instant SQLITE_BUSY
    // (measured live: a worker's run insert failed 20ms after delegation,
    // mid conversation-evidence transaction). Wait long enough to ride out a
    // millisecond-scale evidence transaction, short enough that two durable
    // schedulers racing one claim still resolve to one winner promptly.
    await database.run(sql`PRAGMA busy_timeout = 1500`);
    await migrate(database, {
      migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
    });
  } catch (error) {
    client.close();
    throw error;
  }

  let closed = false;
  return {
    repositories: repositories(database),
    close: async () => {
      if (closed) return;
      closed = true;
      client.close();
    },
  };
}
