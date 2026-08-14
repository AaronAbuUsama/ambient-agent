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
      agentId: "memory-main",
      role: "memory",
      conversationId: "chat-1",
      model,
      promptVersion: "memory-v1",
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

test("task leases are single-flight and invalid transitions are rejected", async () => {
  await withDatabase(async ({ repositories }) => {
    const requestRun = await repositories.runs.start({
      id: "request-run",
      agentId: "worker-main",
      role: "worker",
      conversationId: "chat-1",
      model,
      promptVersion: "worker-v1",
      input: {},
    });
    const { task, outcome } = await repositories.tasks.create({
      id: "task-1",
      conversationId: "chat-1",
      requestedByRunId: requestRun.id,
      objective: "Prepare the report",
      workerProfile: "default",
      createdAt: "2026-08-11T10:00:00.000Z",
    });
    expect(outcome).toBe("created");

    // The id derives from the delegating tool call: re-creating is adoption,
    // never a second assignment.
    const again = await repositories.tasks.create({
      id: "task-1",
      conversationId: "chat-1",
      requestedByRunId: requestRun.id,
      objective: "Prepare the report",
      workerProfile: "default",
      createdAt: "2026-08-11T10:00:30.000Z",
    });
    expect(again.outcome).toBe("adopted");
    expect(again.task.createdAt).toBe(task.createdAt);
    expect(await repositories.tasks.countActive("chat-1")).toBe(1);

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
    expect(await repositories.tasks.countActive("chat-1")).toBe(0);
  });
});

test("artifacts are idempotent receipts and attempts number worker runs", async () => {
  await withDatabase(async ({ repositories }) => {
    const requestRun = await repositories.runs.start({
      id: "request-run",
      agentId: "worker-main",
      role: "worker",
      conversationId: "chat-1",
      model,
      promptVersion: "worker-v1",
      input: {},
    });
    const { task } = await repositories.tasks.create({
      id: "task-2",
      conversationId: "chat-1",
      requestedByRunId: requestRun.id,
      objective: "File the crash report",
      workerProfile: "github-issues",
      createdAt: "2026-08-11T11:00:00.000Z",
    });

    const receipt = await repositories.tasks.recordArtifact({
      taskId: task.id,
      kind: "url",
      title: "issue",
      value: "https://github.com/owner/sandbox/issues/7",
      createdAt: "2026-08-11T11:01:00.000Z",
    });
    // Retaining the same receipt twice is one receipt — the authority stays
    // single even when the writer retries.
    const retained = await repositories.tasks.recordArtifact({
      taskId: task.id,
      kind: "url",
      title: "issue",
      value: "https://github.com/owner/sandbox/issues/7",
      createdAt: "2026-08-11T11:02:00.000Z",
    });
    expect(retained.id).toBe(receipt.id);
    expect(await repositories.tasks.listArtifacts(task.id)).toHaveLength(1);

    const workerRun = async (id: string) =>
      repositories.runs.start({
        id,
        agentId: "worker",
        role: "worker",
        conversationId: "chat-1",
        taskId: task.id,
        model,
        promptVersion: "worker-v1",
        input: {},
      });
    await workerRun("worker-run-1");
    await workerRun("worker-run-2");
    expect(
      await repositories.tasks.recordAttempt({ taskId: task.id, runId: "worker-run-1" }),
    ).toEqual({ attempt: 1 });
    expect(
      await repositories.tasks.recordAttempt({ taskId: task.id, runId: "worker-run-2" }),
    ).toEqual({ attempt: 2 });
    // Idempotent per run: recording the same run again keeps its number.
    expect(
      await repositories.tasks.recordAttempt({ taskId: task.id, runId: "worker-run-1" }),
    ).toEqual({ attempt: 1 });
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
    await repositories.memory.linkIdentity({
      id: "identity-1",
      entityId: "entity-1",
      namespace: "whatsapp",
      nativeId: "alice@s.whatsapp.net",
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
    expect(
      await repositories.memory.recall({
        nativeIds: ["alice@s.whatsapp.net"],
        query: "works",
      }),
    ).toEqual([
      {
        claimId: "claim-2",
        text: 'Alice works_at: "New Acme"',
        confidence: "confirmed",
        evidenceObservationIds: ["evidence-1"],
      },
    ]);
    expect(
      await repositories.memory.recall({
        nativeIds: ["unrelated@s.whatsapp.net"],
        query: "",
      }),
    ).toEqual([]);
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

test("memory recall limits current claims after collapsing historical versions", async () => {
  await withDatabase(async ({ repositories }) => {
    await repositories.runs.start({
      id: "recall-run",
      agentId: "memory-main",
      role: "memory",
      model,
      promptVersion: "memory-v1",
      input: {},
    });
    await repositories.observations.retain({
      id: "recall-evidence",
      source: "whatsapp",
      accountId: "main",
      nativeId: "recall-message",
      occurredAt: "2026-08-11T10:00:00.000Z",
      kind: "message",
      payload: { text: "Alice's favorite color is orange" },
    });
    await repositories.memory.putEntity({
      id: "recall-entity",
      kind: "person",
      canonicalName: "Alice",
    });
    await repositories.memory.linkIdentity({
      entityId: "recall-entity",
      namespace: "whatsapp",
      nativeId: "recall@s.whatsapp.net",
    });
    await repositories.memory.putPredicate({
      id: "000-history",
      name: "history",
      description: "A deliberately long claim history",
      valueSchema: { type: "number" },
    });
    await repositories.memory.putPredicate({
      id: "zzz-favorite",
      name: "favorite_color",
      description: "Favorite color",
      valueSchema: { type: "string" },
    });
    await repositories.memory.applyPatch({
      id: "recall-history-patch",
      runId: "recall-run",
      source: {},
      operations: [
        {
          operation: "create",
          claimId: "history-1",
          entityId: "recall-entity",
          predicateId: "000-history",
          value: 1,
          confidence: "high",
          evidenceObservationIds: ["recall-evidence"],
        },
        ...Array.from({ length: 500 }, (_, index) => {
          const version = index + 2;
          return {
            operation: "supersede" as const,
            claimId: `history-${version}`,
            supersedesClaimId: `history-${version - 1}`,
            expectedVersion: version - 1,
            value: version,
            confidence: "high" as const,
            evidenceObservationIds: ["recall-evidence"],
          };
        }),
        {
          operation: "create",
          claimId: "favorite-color",
          entityId: "recall-entity",
          predicateId: "zzz-favorite",
          value: "orange",
          confidence: "confirmed",
          evidenceObservationIds: ["recall-evidence"],
        },
      ],
    });

    expect(
      await repositories.memory.recall({
        nativeIds: ["recall@s.whatsapp.net"],
        query: "favorite",
        limit: 1,
      }),
    ).toEqual([
      {
        claimId: "favorite-color",
        text: 'Alice favorite_color: "orange"',
        confidence: "confirmed",
        evidenceObservationIds: ["recall-evidence"],
      },
    ]);
  });
});

test("an issue is recallable through its conversation even though it is nobody's identity", async () => {
  await withDatabase(async ({ repositories }) => {
    await repositories.runs.start({
      id: "issue-run",
      agentId: "memory-main",
      role: "memory",
      model,
      promptVersion: "memory-v1",
      input: {},
    });
    await repositories.observations.retain({
      id: "issue-evidence",
      source: "whatsapp",
      accountId: "main",
      nativeId: "issue-message",
      conversationId: "group@g.us",
      occurredAt: "2026-08-13T15:16:00.000Z",
      kind: "message",
      payload: {
        kind: "image",
        media: { ref: "media:v1:deadbeef", mimetype: "image/jpeg", caption: "Live Activity loops" },
      },
    });
    await repositories.memory.putEntity({
      id: "issue-entity",
      kind: "issue",
      canonicalName: "Live Activity repeats prayer prompts",
    });
    await repositories.memory.putPredicate({
      id: "issue-status",
      name: "issue_status",
      description: "The latest explicitly stated status of an issue",
      valueSchema: {},
    });
    await repositories.memory.applyPatch({
      id: "issue-patch",
      runId: "issue-run",
      source: {},
      operations: [
        {
          operation: "create",
          claimId: "issue-claim",
          entityId: "issue-entity",
          predicateId: "issue-status",
          value: "open",
          confidence: "high",
          evidenceObservationIds: ["issue-evidence"],
        },
      ],
    });

    // The old wire: an issue is not linked to any phone number, so a
    // person-scoped recall can never surface it however it is queried.
    expect(
      await repositories.memory.recall({ nativeIds: ["someone@s.whatsapp.net"], query: "" }),
    ).toEqual([]);

    // The fix: the conversation's own evidence reaches it.
    const recalled = await repositories.memory.recall({
      conversationId: "group@g.us",
      nativeIds: ["someone@s.whatsapp.net"],
      query: "",
    });
    expect(recalled).toEqual([
      {
        claimId: "issue-claim",
        text: 'Live Activity repeats prayer prompts issue_status: "open"',
        confidence: "high",
        evidenceObservationIds: ["issue-evidence"],
      },
    ]);

    // History search reads the retained message itself, caption and all.
    expect(
      await repositories.memory.searchHistory({ conversationId: "group@g.us", query: "live" }),
    ).toEqual([
      {
        observationId: "issue-evidence",
        sentAt: "2026-08-13T15:16:00.000Z",
        text: "Live Activity loops",
        attachment: { kind: "image", ref: "media:v1:deadbeef", mimetype: "image/jpeg" },
      },
    ]);
    expect(
      await repositories.memory.searchHistory({ conversationId: "group@g.us", query: "nothing" }),
    ).toEqual([]);
  });
});
