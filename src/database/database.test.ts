import { expect, test } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { openAmbientDatabase, type AmbientDatabase } from "./database";

const model = {
  provider: "test",
  model: "deterministic",
  thinking: "off" as const,
  maxOutputTokens: 1024,
};

async function withDatabase(
  work: (database: AmbientDatabase, url: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ambient-db-"));
  const url = `file:${join(directory, "ambient.db")}`;
  const database = await openAmbientDatabase(url);
  try {
    await work(database, url);
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function expectFailure(work: () => Promise<unknown>, message: string): Promise<void> {
  let failure: unknown;
  try {
    await work();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  const messages: string[] = [];
  let current: unknown = failure;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  expect(messages.join("\n")).toContain(message);
}

test("migrations are repeatable and retained observations survive restart", async () => {
  await withDatabase(async (database, url) => {
    const first = await database.repositories.observations.retain({
      id: "observation-1",
      source: "whatsapp",
      accountId: "main",
      nativeId: "wa-message-1",
      conversationId: "chat-1",
      occurredAt: "2026-08-11T10:00:00.000Z",
      kind: "message",
      payload: { text: "hello" },
      createdAt: "2026-08-11T10:00:01.000Z",
    });
    const duplicate = await database.repositories.observations.retain({
      id: "ignored-duplicate-id",
      source: "whatsapp",
      accountId: "main",
      nativeId: "wa-message-1",
      conversationId: "chat-1",
      occurredAt: "2026-08-11T10:00:00.000Z",
      kind: "message",
      payload: { text: "duplicate" },
    });

    expect(first.accepted).toBe(true);
    expect(duplicate.accepted).toBe(false);
    expect(duplicate.observation.id).toBe("observation-1");
    await database.repositories.runs.start({
      id: "restart-run",
      agentId: "conversation-main",
      role: "conversation",
      conversationId: "chat-1",
      model,
      promptVersion: "conversation-v1",
      input: { observationIds: ["observation-1"] },
    });
    await database.repositories.inbox.enqueue({
      id: "restart-inbox",
      conversationId: "chat-1",
      kind: "message",
      referenceId: "observation-1",
    });

    await database.close();
    const reopened = await openAmbientDatabase(url);
    try {
      expect(await reopened.repositories.observations.get("observation-1")).toEqual(
        first.observation,
      );
      expect((await reopened.repositories.runs.get("restart-run"))?.status).toBe("running");
      expect((await reopened.repositories.inbox.pending("chat-1")).map((item) => item.id)).toEqual([
        "restart-inbox",
      ]);
    } finally {
      await reopened.close();
    }
  });
});

test("concurrent initialization serializes migrations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ambient-concurrent-"));
  const url = `file:${join(directory, "ambient.db")}`;
  try {
    const [first, second] = await Promise.all([openAmbientDatabase(url), openAmbientDatabase(url)]);
    await Promise.all([first.close(), second.close()]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("relative file URLs create the same database libSQL opens", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ambient-relative-"));
  const path = join(directory, "ambient.db");
  const database = await openAmbientDatabase(`file:${relative(process.cwd(), path)}`);
  try {
    await database.repositories.observations.retain({
      source: "worker",
      accountId: "main",
      nativeId: "relative-path-proof",
      occurredAt: "2026-08-11T10:00:00.000Z",
      kind: "worker_result",
      payload: {},
    });
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("agent runs retain model snapshots and enforce terminal state", async () => {
  await withDatabase(async ({ repositories }) => {
    const run = await repositories.runs.start({
      id: "run-1",
      agentId: "conversation-main",
      role: "conversation",
      conversationId: "chat-1",
      model,
      promptVersion: "conversation-v1",
      input: { observationIds: ["observation-1"] },
      startedAt: "2026-08-11T10:00:00.000Z",
    });
    const call = await repositories.runs.startToolCall({
      id: "call-1",
      runId: run.id,
      callId: "model-call-1",
      toolName: "recall",
      input: { query: "project" },
      startedAt: "2026-08-11T10:00:01.000Z",
    });

    await expectFailure(
      () => repositories.runs.succeed(run.id, { summary: "too early" }),
      "cannot finish with active tool calls",
    );
    await repositories.runs.completeToolCall(
      call.id,
      { outcome: "succeeded", output: { claims: [] } },
      "2026-08-11T10:00:02.000Z",
    );
    const completed = await repositories.runs.succeed(
      run.id,
      { summary: "done" },
      "2026-08-11T10:00:03.000Z",
    );

    expect(completed.model).toEqual(model);
    expect(completed.status).toBe("succeeded");
    await expectFailure(
      () =>
        repositories.runs.startToolCall({
          runId: run.id,
          callId: "late-call",
          toolName: "recall",
          input: {},
        }),
      'cannot start tool calls from status "succeeded"',
    );
    await expectFailure(
      () => repositories.runs.fail(run.id, "too late"),
      'cannot finish from status "succeeded"',
    );
  });
});

test("inbox claims retain immutable run ranges and consume each item once", async () => {
  await withDatabase(async ({ repositories }) => {
    for (const id of ["run-1", "run-2", "run-3"]) {
      await repositories.runs.start({
        id,
        agentId: "conversation-main",
        role: "conversation",
        conversationId: "chat-1",
        model,
        promptVersion: "conversation-v1",
        input: {},
      });
    }
    await repositories.runs.start({
      id: "wrong-conversation-run",
      agentId: "conversation-main",
      role: "conversation",
      conversationId: "chat-2",
      model,
      promptVersion: "conversation-v1",
      input: {},
    });
    for (const [index, referenceId] of ["observation-1", "observation-2"].entries()) {
      await repositories.inbox.enqueue({
        id: `inbox-${index + 1}`,
        conversationId: "chat-1",
        kind: "message",
        referenceId,
        createdAt: `2026-08-11T10:00:0${index}.000Z`,
      });
    }

    await expectFailure(
      () => repositories.inbox.claim("chat-1", "wrong-conversation-run", 1),
      "cannot claim inbox",
    );
    const firstRange = await repositories.inbox.claim("chat-1", "run-1", 1);
    const secondRange = await repositories.inbox.claim("chat-1", "run-2", 10);
    expect(firstRange.map((item) => item.id)).toEqual(["inbox-1"]);
    expect(secondRange.map((item) => item.id)).toEqual(["inbox-2"]);

    await expectFailure(() => repositories.inbox.consume("run-1"), "must succeed before");
    await repositories.runs.succeed("run-1", {});
    expect(await repositories.inbox.consume("run-1")).toBe(1);
    expect(await repositories.inbox.consume("run-1")).toBe(0);
    await expectFailure(() => repositories.inbox.release("run-2"), "must fail before");
    await repositories.runs.fail("run-2", "retry");
    expect(await repositories.inbox.release("run-2")).toBe(1);

    const retriedRange = await repositories.inbox.claim("chat-1", "run-3", 10);
    expect(retriedRange.map((item) => item.id)).toEqual(["inbox-2"]);
  });
});

test("task leases are single-flight and invalid transitions are rejected", async () => {
  await withDatabase(async ({ repositories }) => {
    const requestRun = await repositories.runs.start({
      id: "request-run",
      agentId: "conversation-main",
      role: "conversation",
      conversationId: "chat-1",
      model,
      promptVersion: "conversation-v1",
      input: {},
    });
    const task = await repositories.tasks.create({
      id: "task-1",
      conversationId: "chat-1",
      requestedByRunId: requestRun.id,
      objective: "Prepare the report",
      workerProfile: "default",
      createdAt: "2026-08-11T10:00:00.000Z",
    });

    const claimed = await repositories.tasks.claimNext({
      workerId: "worker-1",
      now: "2026-08-11T10:00:01.000Z",
      leaseUntil: "2026-08-11T10:05:01.000Z",
    });
    const secondClaim = await repositories.tasks.claimNext({
      workerId: "worker-2",
      now: "2026-08-11T10:00:01.000Z",
      leaseUntil: "2026-08-11T10:05:01.000Z",
    });

    expect(claimed?.id).toBe(task.id);
    expect(secondClaim).toBeUndefined();
    await expectFailure(
      () => repositories.tasks.transition(task.id, { to: "queued" }),
      "invalid task transition: running -> queued",
    );
    await expectFailure(
      () =>
        repositories.tasks.transition(task.id, {
          to: "failed",
          leaseOwner: "worker-2",
        }),
      'does not have an active lease for "worker-2"',
    );

    await repositories.tasks.transition(task.id, {
      to: "failed",
      leaseOwner: "worker-1",
      at: "2026-08-11T10:01:00.000Z",
      resultSummary: "temporary failure",
    });
    const queued = await repositories.tasks.transition(task.id, {
      to: "queued",
      at: "2026-08-11T10:02:00.000Z",
    });
    expect(queued.status).toBe("queued");
    expect(queued.resultSummary).toBeUndefined();
    expect(queued.startedAt).toBeUndefined();
    expect(queued.completedAt).toBeUndefined();

    await repositories.tasks.claimNext({
      workerId: "worker-1",
      now: "2026-08-11T10:02:01.000Z",
      leaseUntil: "2026-08-11T10:02:02.000Z",
    });
    const recovered = await repositories.tasks.claimNext({
      workerId: "worker-2",
      now: "2026-08-11T10:02:03.000Z",
      leaseUntil: "2026-08-11T10:07:03.000Z",
    });
    expect(recovered?.leaseOwner).toBe("worker-2");
    await expectFailure(
      () =>
        repositories.tasks.transition(task.id, {
          to: "succeeded",
          leaseOwner: "worker-1",
        }),
      'does not have an active lease for "worker-1"',
    );
    const succeeded = await repositories.tasks.transition(task.id, {
      to: "succeeded",
      leaseOwner: "worker-2",
      at: "2026-08-11T10:03:00.000Z",
      resultSummary: "report ready",
    });
    expect(succeeded.status).toBe("succeeded");
  });
});

test("evaluation records persist independently of live agent sessions", async () => {
  await withDatabase(async ({ repositories }) => {
    const evaluation = await repositories.evaluations.start({
      id: "evaluation-1",
      role: "conversation",
      caseId: "responds-or-remains-silent",
      configuration: { promptVersion: "conversation-v1", model },
      startedAt: "2026-08-11T10:00:00.000Z",
    });
    await repositories.evaluations.recordResult({
      evaluationRunId: evaluation.id,
      metric: "valid_terminal_decision",
      passed: true,
      detail: { decision: "silent" },
    });
    await repositories.evaluations.annotate({
      evaluationRunId: evaluation.id,
      label: "fixture",
      value: "quiet-conversation",
      createdAt: "2026-08-11T10:00:01.000Z",
    });

    const completed = await repositories.evaluations.finish(
      evaluation.id,
      { status: "succeeded" },
      "2026-08-11T10:00:02.000Z",
    );
    expect(completed.status).toBe("succeeded");
  });
});

test("claim versions and evidence references are enforced by the database", async () => {
  await withDatabase(async ({ repositories }) => {
    await repositories.runs.start({
      id: "memory-run",
      agentId: "memory-main",
      role: "memory",
      model,
      promptVersion: "memory-v1",
      input: {},
    });
    await repositories.observations.retain({
      id: "evidence-1",
      source: "whatsapp",
      accountId: "main",
      nativeId: "message-1",
      occurredAt: "2026-08-11T10:00:00.000Z",
      kind: "message",
      payload: { text: "Alice works at Acme" },
    });
    await repositories.memory.putEntity({
      id: "entity-1",
      kind: "person",
      canonicalName: "Alice",
    });
    await repositories.memory.putPredicate({
      id: "predicate-1",
      name: "works_at",
      description: "Current employer",
      valueSchema: { type: "string" },
    });
    await repositories.memory.applyPatch({
      id: "patch-1",
      runId: "memory-run",
      source: { episodeId: "episode-1" },
      operations: [
        {
          operation: "create",
          claimId: "claim-1",
          entityId: "entity-1",
          predicateId: "predicate-1",
          value: "Acme",
          confidence: "high",
          evidenceObservationIds: ["evidence-1"],
        },
      ],
    });

    await expectFailure(
      () =>
        repositories.memory.applyPatch({
          id: "stale-patch",
          runId: "memory-run",
          source: {},
          operations: [
            {
              operation: "supersede",
              claimId: "stale-claim",
              supersedesClaimId: "claim-1",
              expectedVersion: 2,
              value: "Wrong",
              confidence: "low",
              evidenceObservationIds: ["evidence-1"],
            },
          ],
        }),
      "expected version 2, found 1",
    );

    await repositories.memory.applyPatch({
      id: "patch-2",
      runId: "memory-run",
      source: {},
      operations: [
        {
          operation: "supersede",
          claimId: "claim-2",
          supersedesClaimId: "claim-1",
          expectedVersion: 1,
          value: "New Acme",
          confidence: "confirmed",
          evidenceObservationIds: ["evidence-1"],
        },
      ],
    });
    await expectFailure(
      () =>
        repositories.memory.applyPatch({
          id: "second-successor-patch",
          runId: "memory-run",
          source: {},
          operations: [
            {
              operation: "supersede",
              claimId: "claim-3",
              supersedesClaimId: "claim-1",
              expectedVersion: 1,
              value: "Third",
              confidence: "low",
              evidenceObservationIds: ["evidence-1"],
            },
          ],
        }),
      "UNIQUE",
    );
    await repositories.memory.putPredicate({
      id: "predicate-2",
      name: "lives_at",
      description: "Current home",
      valueSchema: { type: "string" },
    });
    await expectFailure(
      () =>
        repositories.memory.applyPatch({
          id: "unsupported-patch",
          runId: "memory-run",
          source: {},
          operations: [
            {
              operation: "create",
              claimId: "unsupported-claim",
              entityId: "entity-1",
              predicateId: "predicate-2",
              value: "Unsupported",
              confidence: "low",
              evidenceObservationIds: ["missing-observation"],
            },
          ],
        }),
      "FOREIGN KEY",
    );

    expect(
      await Promise.all(["patch-1", "patch-2"].map((id) => repositories.memory.getPatch(id))),
    ).toEqual([
      { id: "patch-1", status: "applied", error: undefined },
      { id: "patch-2", status: "applied", error: undefined },
    ]);
    expect(
      await Promise.all(
        ["stale-patch", "second-successor-patch", "unsupported-patch"].map((id) =>
          repositories.memory.getPatch(id),
        ),
      ),
    ).toEqual([
      expect.objectContaining({ id: "stale-patch", status: "rejected" }),
      expect.objectContaining({ id: "second-successor-patch", status: "rejected" }),
      expect.objectContaining({ id: "unsupported-patch", status: "rejected" }),
    ]);
  });
});
