import { expect, test } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAmbientDatabase, type AmbientDatabase } from "../database/database";
import type { ConversationJudge, ConversationRunEvidence } from "./contract";
import { createEvaluationService } from "./service";

const model = {
  provider: "test",
  model: "deterministic",
  thinking: "off" as const,
  maxOutputTokens: 1024,
};

const scheduling = {
  debounceMs: 10,
  maximumWaitMs: 100,
  leaseMs: 60_000,
  maximumItemsPerRun: 10,
};

async function withDatabase(work: (database: AmbientDatabase) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ambient-evals-"));
  const url = `file:${join(directory, "ambient.db")}`;
  const database = await openAmbientDatabase(url);
  try {
    await work(database);
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function retainMessage(database: AmbientDatabase, id = "1"): Promise<void> {
  const createdAt = "2026-08-11T10:00:00.000Z";
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

async function terminalRun(
  database: AmbientDatabase,
  outcome: { readonly kind: "reply" } | { readonly kind: "silence" } | { readonly kind: "fail" },
): Promise<string> {
  await database.repositories.speakers.sync([
    { conversationId: "chat-1", mode: "responding", attendFrom: "2026-08-11T00:00:00.000Z" },
  ]);
  await retainMessage(database);
  const work = database.repositories.conversationWork;
  await work.notify("chat-1", scheduling);
  const claim = await work.claimNext({
    leaseOwner: "scheduler-1",
    now: "2026-08-11T10:00:01.000Z",
    model,
    agentId: "conversation-main",
    promptVersion: "conversation-v1",
    scheduling,
  });
  if (!claim) throw new Error("no claim");
  if (outcome.kind === "reply") {
    const { toolCallId } = await work.beginTool({
      runId: claim.runId,
      callId: "call-1",
      toolName: "send_message",
      input: { conversationId: "chat-1", text: "hello back" },
    });
    await work.finishTool({
      toolCallId,
      result: { outcome: "succeeded", output: { operationId: "operation-1" } },
    });
  }
  if (outcome.kind === "fail") {
    await work.fail({
      runId: claim.runId,
      leaseOwner: "scheduler-1",
      error: "model unavailable",
      completedAt: "2026-08-11T10:00:02.000Z",
      scheduling,
    });
  } else {
    await work.complete({
      runId: claim.runId,
      leaseOwner: "scheduler-1",
      result: { summary: "handled" },
      completedAt: "2026-08-11T10:00:02.000Z",
      scheduling,
    });
  }
  return claim.runId;
}

function fakeJudge(database: AmbientDatabase, seen: ConversationRunEvidence[]): ConversationJudge {
  return {
    async judge(evidence) {
      seen.push(evidence);
      const run = await database.repositories.runs.start({
        agentId: "evaluator-judge",
        role: "evaluator",
        model,
        promptVersion: "evaluator-judge-v1",
        input: { subjectRunId: evidence.runId },
      });
      await database.repositories.runs.finish(run.id, {
        status: "succeeded",
        result: { quality: 1 },
      });
      return {
        evaluatorRunId: run.id,
        metrics: [{ metric: "reply_quality", score: 1, detail: { rationale: "fine" } }],
      };
    },
  };
}

test("terminal runs durably signal evaluation and the runner records contract and judged cases", async () => {
  await withDatabase(async (database) => {
    const runId = await terminalRun(database, { kind: "reply" });
    const seen: ConversationRunEvidence[] = [];
    const service = createEvaluationService({
      work: database.repositories.evaluationWork,
      recorder: database.repositories.evaluations,
      judge: fakeJudge(database, seen),
      maximumItemsPerRun: scheduling.maximumItemsPerRun,
    });

    expect(await service.runOnce()).toBe("processed");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      runId,
      conversationId: "chat-1",
      status: "succeeded",
      promptVersion: "conversation-v1",
      itemCount: 1,
      newMessages: [{ senderId: "person@s.whatsapp.net", text: "hello 1" }],
      reply: { text: "hello back", operationId: "operation-1" },
      summary: "handled",
    });

    const evaluations = await database.repositories.evaluations.forSubject(runId);
    expect(evaluations.map(({ caseId, status }) => ({ caseId, status }))).toEqual([
      { caseId: "conversation-contract-v1", status: "succeeded" },
      { caseId: "conversation-judged-v1", status: "succeeded" },
    ]);
    expect(evaluations[1]?.evaluatorRunId).toBeDefined();

    // The signal is consumed exactly once.
    expect(await service.runOnce()).toBe("idle");
  });
});

test("failed runs are evaluated without judging", async () => {
  await withDatabase(async (database) => {
    const runId = await terminalRun(database, { kind: "fail" });
    const service = createEvaluationService({
      work: database.repositories.evaluationWork,
      recorder: database.repositories.evaluations,
      judge: {
        judge() {
          throw new Error("failed runs must not be judged");
        },
      },
      maximumItemsPerRun: scheduling.maximumItemsPerRun,
    });

    expect(await service.runOnce()).toBe("processed");
    const evaluations = await database.repositories.evaluations.forSubject(runId);
    expect(evaluations.map(({ caseId, status }) => ({ caseId, status }))).toEqual([
      { caseId: "conversation-contract-v1", status: "succeeded" },
    ]);
  });
});

test("judge failure retains a failed judged evaluation and still consumes the signal", async () => {
  await withDatabase(async (database) => {
    const runId = await terminalRun(database, { kind: "silence" });
    const service = createEvaluationService({
      work: database.repositories.evaluationWork,
      recorder: database.repositories.evaluations,
      judge: {
        judge() {
          return Promise.reject(new Error("judge model unavailable"));
        },
      },
      maximumItemsPerRun: scheduling.maximumItemsPerRun,
    });

    expect(await service.runOnce()).toBe("processed");
    const evaluations = await database.repositories.evaluations.forSubject(runId);
    expect(evaluations.map(({ caseId, status }) => ({ caseId, status }))).toEqual([
      { caseId: "conversation-contract-v1", status: "succeeded" },
      { caseId: "conversation-judged-v1", status: "failed" },
    ]);
    expect(await service.runOnce()).toBe("idle");
  });
});

test("an expired evaluation lease makes the subject claimable again", async () => {
  await withDatabase(async (database) => {
    const runId = await terminalRun(database, { kind: "silence" });
    const work = database.repositories.evaluationWork;

    const first = await work.claimNext({
      leaseOwner: "runner-a",
      leaseMs: 1_000,
      now: "2026-08-12T10:00:00.000Z",
    });
    expect(first?.runId).toBe(runId);
    expect(
      await work.claimNext({
        leaseOwner: "runner-b",
        leaseMs: 1_000,
        now: "2026-08-12T10:00:00.500Z",
      }),
    ).toBeUndefined();
    const reclaimed = await work.claimNext({
      leaseOwner: "runner-b",
      leaseMs: 1_000,
      now: "2026-08-12T10:00:02.000Z",
    });
    expect(reclaimed?.runId).toBe(runId);
  });
});

test("expired conversation leases also signal evaluation", async () => {
  await withDatabase(async (database) => {
    await database.repositories.speakers.sync([
      { conversationId: "chat-1", mode: "responding", attendFrom: "2026-08-11T00:00:00.000Z" },
    ]);
    await retainMessage(database);
    const work = database.repositories.conversationWork;
    await work.notify("chat-1", scheduling);
    const abandoned = await work.claimNext({
      leaseOwner: "scheduler-1",
      now: "2026-08-11T10:00:01.000Z",
      model,
      agentId: "conversation-main",
      promptVersion: "conversation-v1",
      scheduling: { ...scheduling, leaseMs: 1_000 },
    });
    // The lease expires; the next claim recovers the abandoned run.
    await work.claimNext({
      leaseOwner: "scheduler-2",
      now: "2026-08-11T10:00:03.000Z",
      model,
      agentId: "conversation-main",
      promptVersion: "conversation-v1",
      scheduling,
    });

    const evidence = await database.repositories.evaluationWork.claimNext({
      leaseOwner: "runner-a",
      leaseMs: 1_000,
    });
    expect(evidence).toMatchObject({
      runId: abandoned?.runId,
      status: "failed",
      error: "conversation lease expired",
    });
  });
});
