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
import { createMemoryRepository, type MemoryRepository } from "./memory";
import { createMemoryWorkStore } from "./memory-work";
import {
  createMessageIngestionRepository,
  type MessageIngestionRepository,
} from "./message-ingestion";
import { createObservationRepository, type ObservationRepository } from "./observations";
import { createRunRepository, type RunRepository } from "./runs";
import { createTaskRepository, type TaskRepository } from "./tasks";

export interface AmbientRepositories {
  readonly observations: ObservationRepository;
  readonly messageIngestion: MessageIngestionRepository;
  readonly inbox: ConversationInboxRepository;
  readonly conversationWork: ConversationWorkStore;
  readonly speakers: ConversationSpeakerStore;
  readonly memory: MemoryRepository;
  readonly memoryWork: MemoryWorkStore;
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
    observations: createObservationRepository(database),
    messageIngestion: createMessageIngestionRepository(database),
    inbox: createConversationInboxRepository(database),
    conversationWork: createConversationWorkStore(database),
    speakers: createConversationSpeakerStore(database),
    runs: createRunRepository(database),
    tasks: createTaskRepository(database),
    evaluations,
    evaluationWork: createEvaluationWorkStore(database),
    memory: createMemoryRepository(database),
    memoryWork: createMemoryWorkStore(database),
  };
}

export async function openAmbientDatabase(url: string): Promise<AmbientDatabase> {
  await prepareLocalDirectory(url);
  const client = createClient({ url });
  const database = drizzle(client, { schema });
  try {
    await database.run(sql`PRAGMA foreign_keys = ON`);
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
