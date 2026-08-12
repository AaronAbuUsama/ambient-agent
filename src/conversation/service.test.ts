import { expect, test } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelConfig } from "../models/contract";
import { openAmbientDatabase, type AmbientDatabase } from "../database/database";
import { createConversationEvaluationSink } from "../database/evaluations";
import type { ConversationAgent, ScopedMessageSender } from "./contract";
import { createConversationService } from "./service";

const model: ModelConfig = {
  provider: "test",
  model: "deterministic",
  thinking: "off",
  maxOutputTokens: 1024,
};

const scheduling = {
  debounceMs: 10,
  maximumWaitMs: 100,
  leaseMs: 1_000,
  maximumItemsPerRun: 10,
};

async function withDatabase(
  work: (database: AmbientDatabase, url: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ambient-conversation-"));
  const url = `file:${join(directory, "ambient.db")}`;
  const database = await openAmbientDatabase(url);
  try {
    await work(database, url);
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function retainMessage(
  database: AmbientDatabase,
  id = "1",
  createdAt = "2026-08-11T10:00:00.000Z",
): Promise<void> {
  const observation = await database.repositories.observations.retain({
    id: `observation-${id}`,
    source: "whatsapp",
    accountId: "main",
    nativeId: `native-${id}`,
    conversationId: "chat-1",
    occurredAt: createdAt,
    kind: "message",
    payload: {
      version: 1,
      messageId: `message-${id}`,
      chatId: "chat-1",
      sender: { id: "person@s.whatsapp.net", mode: "pn" },
      fromMe: false,
      timestamp: Date.parse(createdAt),
      live: true,
      isGroup: false,
      text: `hello ${id}`,
    },
    createdAt,
  });
  await database.repositories.inbox.enqueue({
    id: `inbox-${id}`,
    conversationId: "chat-1",
    kind: "message",
    referenceId: observation.observation.id,
    createdAt,
  });
}

function service(
  database: AmbientDatabase,
  agent: ConversationAgent,
  sender: ScopedMessageSender,
  completedAt: () => string = () => "2026-08-11T10:00:00.020Z",
  evaluationSubjects: string[] = [],
) {
  const evaluations = database.repositories.evaluations;
  return createConversationService({
    leaseOwner: "service-1",
    scheduling,
    work: database.repositories.conversationWork,
    recall: database.repositories.memory,
    evaluation: createConversationEvaluationSink({
      ...evaluations,
      start(input) {
        if (input.subjectRunId) evaluationSubjects.push(input.subjectRunId);
        return evaluations.start(input);
      },
    }),
    agent,
    sender,
    now: () => new Date(completedAt()),
  });
}

test("Conversation builds retained context and scopes one send to its conversation", async () => {
  await withDatabase(async (database) => {
    await retainMessage(database);
    await database.repositories.conversationWork.notify("chat-1", scheduling);
    const sends: Array<{
      readonly conversationId: string;
      readonly text: string;
      readonly idempotencyKey: string;
    }> = [];
    const evaluationSubjects: string[] = [];
    const agent: ConversationAgent = {
      model,
      async run(input, tools) {
        expect(input).toMatchObject({
          conversationId: "chat-1",
          newMessages: [
            {
              observationId: "observation-1",
              whatsappMessageId: "message-1",
              senderId: "person@s.whatsapp.net",
              text: "hello 1",
              fromAgent: false,
            },
          ],
        });
        await tools.sendMessage("hello back", "call-1");
        return { summary: "Replied to the greeting." };
      },
    };
    const runner = service(
      database,
      agent,
      {
        async sendText(input) {
          sends.push(input);
          return { operationId: "operation-1" };
        },
      },
      undefined,
      evaluationSubjects,
    );

    expect(await runner.runOnce("2026-08-11T10:00:00.010Z")).toBe("succeeded");
    expect(sends).toEqual([
      {
        conversationId: "chat-1",
        text: "hello back",
        idempotencyKey: "conversation:inbox-1:send_message",
      },
    ]);
    expect(await database.repositories.inbox.pending("chat-1")).toEqual([]);
    expect(evaluationSubjects).toHaveLength(1);
    expect(
      await database.repositories.evaluations.forSubject(evaluationSubjects[0]!),
    ).toMatchObject([
      {
        role: "conversation",
        caseId: "conversation-contract-v1",
        status: "succeeded",
      },
    ]);
  });
});

test("Conversation can deliberately remain silent", async () => {
  await withDatabase(async (database) => {
    await retainMessage(database);
    await database.repositories.conversationWork.notify("chat-1", scheduling);
    const agent: ConversationAgent = {
      model,
      async run() {
        return { summary: "No response was useful." };
      },
    };
    const runner = service(database, agent, {
      async sendText() {
        throw new Error("silence must not send");
      },
    });

    expect(await runner.runOnce("2026-08-11T10:00:00.010Z")).toBe("succeeded");
    expect(await database.repositories.inbox.pending("chat-1")).toEqual([]);
  });
});

test("failed sends retry with the same durable idempotency key", async () => {
  await withDatabase(async (database) => {
    await retainMessage(database);
    await database.repositories.conversationWork.notify("chat-1", scheduling);
    const keys: string[] = [];
    let attempts = 0;
    const agent: ConversationAgent = {
      model,
      async run(_input, tools) {
        try {
          await tools.sendMessage("retry me", "call-1");
        } catch {
          return { summary: "The model continued after the tool error." };
        }
        return { summary: "Replied." };
      },
    };
    let completedAt = "2026-08-11T10:00:00.020Z";
    const runner = service(
      database,
      agent,
      {
        async sendText({ idempotencyKey }) {
          keys.push(idempotencyKey);
          attempts += 1;
          if (attempts === 1) throw new Error("temporary send failure");
          return { operationId: "operation-1" };
        },
      },
      () => completedAt,
    );

    expect(await runner.runOnce("2026-08-11T10:00:00.010Z")).toBe("failed");
    expect((await database.repositories.inbox.pending("chat-1")).map(({ id }) => id)).toEqual([
      "inbox-1",
    ]);
    completedAt = "2026-08-11T10:00:00.050Z";
    expect(await runner.runOnce("2026-08-11T10:00:00.040Z")).toBe("succeeded");
    expect(keys).toEqual([
      "conversation:inbox-1:send_message",
      "conversation:inbox-1:send_message",
    ]);
  });
});

test("a submitted message consumes the run even if post-send agent work fails", async () => {
  await withDatabase(async (database) => {
    await retainMessage(database);
    await database.repositories.conversationWork.notify("chat-1", scheduling);
    const agent: ConversationAgent = {
      model,
      async run(_input, tools) {
        await tools.sendMessage("already submitted", "call-1");
        throw new Error("follow-up model turn failed");
      },
    };
    const runner = service(database, agent, {
      async sendText() {
        return { operationId: "operation-1" };
      },
    });

    expect(await runner.runOnce("2026-08-11T10:00:00.010Z")).toBe("succeeded");
    expect(await database.repositories.inbox.pending("chat-1")).toEqual([]);
  });
});

test("Conversation coalesces wake bursts and reconciles only at startup", async () => {
  await withDatabase(async (database) => {
    const work = database.repositories.conversationWork;
    const notifications: string[] = [];
    let reconciliations = 0;
    const runner = createConversationService({
      leaseOwner: "service-1",
      scheduling,
      work: {
        ...work,
        async reconcile(config) {
          reconciliations += 1;
          return work.reconcile(config);
        },
        async notify(conversationId, config) {
          notifications.push(conversationId);
          await work.notify(conversationId, config);
        },
      },
      recall: database.repositories.memory,
      evaluation: createConversationEvaluationSink(database.repositories.evaluations),
      agent: {
        model,
        async run() {
          throw new Error("no run should be due");
        },
      },
      sender: {
        async sendText() {
          throw new Error("no send should occur");
        },
      },
      now: () => new Date("2026-08-11T10:00:00.020Z"),
    });

    await runner.start();
    await Promise.all([runner.wake("chat-1"), runner.wake("chat-1"), runner.wake("chat-2")]);
    await runner.stop();

    expect(reconciliations).toBe(1);
    expect(notifications).toEqual(["chat-1", "chat-2"]);
  });
});

test("Conversation stop aborts an active agent run", async () => {
  await withDatabase(async (database) => {
    await retainMessage(database);
    let started!: () => void;
    const runStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let aborted = false;
    const runner = service(
      database,
      {
        model,
        async run(_input, _tools, signal) {
          started();
          return new Promise((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(signal.reason);
              },
              { once: true },
            );
          });
        },
      },
      {
        async sendText() {
          throw new Error("shutdown must not send");
        },
      },
    );

    const starting = runner.start();
    await runStarted;
    await runner.stop();
    await starting;

    expect(aborted).toBe(true);
    expect((await database.repositories.inbox.pending("chat-1")).map(({ id }) => id)).toEqual([
      "inbox-1",
    ]);
  });
});

test("restart reconciliation recovers committed Inbox work after a lost wake callback", async () => {
  await withDatabase(async (database, url) => {
    // Commit the Observation and Inbox item, then lose the process before the
    // in-memory wake callback ever reaches the Conversation service.
    await retainMessage(database);
    await database.close();

    const restarted = await openAmbientDatabase(url);
    try {
      const evaluationSubjects: string[] = [];
      const runner = service(
        restarted,
        {
          model,
          async run() {
            return { summary: "Recovered after restart." };
          },
        },
        {
          async sendText() {
            throw new Error("recovery must not send");
          },
        },
        () => "2026-08-11T10:00:01.000Z",
        evaluationSubjects,
      );

      // start() reconciles from durable Inbox state and drains due work before
      // resolving; no notify or wake hint is ever delivered.
      await runner.start();
      await runner.stop();

      expect(await restarted.repositories.inbox.pending("chat-1")).toEqual([]);
      expect(evaluationSubjects).toHaveLength(1);
      expect((await restarted.repositories.runs.get(evaluationSubjects[0]!))?.status).toBe(
        "succeeded",
      );
    } finally {
      await restarted.close();
    }
  });
});
