import { expect, test } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationSchedulingConfig } from "../conversation/contract";
import { openAmbientDatabase, type AmbientDatabase } from "./database";

const scheduling: ConversationSchedulingConfig = {
  debounceMs: 1_000,
  maximumWaitMs: 5_000,
  leaseMs: 60_000,
  maximumItemsPerRun: 2,
};

const model = {
  provider: "test",
  model: "deterministic",
  thinking: "off" as const,
  maxOutputTokens: 1024,
};

async function withDatabase(
  work: (database: AmbientDatabase, url: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ambient-schedule-"));
  const url = `file:${join(directory, "ambient.db")}`;
  const database = await openAmbientDatabase(url);
  try {
    await work(database, url);
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function enqueue(
  database: AmbientDatabase,
  id: string,
  createdAt: string,
  conversationId = "chat-1",
): Promise<void> {
  await database.repositories.inbox.enqueue({
    id: `inbox-${id}`,
    conversationId,
    kind: "message",
    referenceId: `observation-${id}`,
    createdAt,
  });
}

function claimInput(
  leaseOwner: string,
  now: string,
  overrides: Partial<ConversationSchedulingConfig> = {},
) {
  return {
    leaseOwner,
    now,
    model,
    agentId: "conversation-main",
    promptVersion: "conversation-v1",
    scheduling: { ...scheduling, ...overrides },
  };
}

test("conversation schedule slides debounce without exceeding maximum wait", async () => {
  await withDatabase(async (database) => {
    const work = database.repositories.conversationWork;
    await enqueue(database, "1", "2026-08-11T10:00:00.000Z");
    await work.notify("chat-1", scheduling);
    expect(await work.nextWakeAt()).toBe("2026-08-11T10:00:01.000Z");

    await enqueue(database, "2", "2026-08-11T10:00:00.500Z");
    await work.notify("chat-1", scheduling);
    expect(await work.nextWakeAt()).toBe("2026-08-11T10:00:01.500Z");

    await enqueue(database, "3", "2026-08-11T10:00:04.800Z");
    await work.notify("chat-1", scheduling);
    expect(await work.nextWakeAt()).toBe("2026-08-11T10:00:05.000Z");
  });
});

test("due claims are bounded, single-flight, and immutable while new items arrive", async () => {
  await withDatabase(async (database) => {
    const work = database.repositories.conversationWork;
    for (const [id, time] of [
      ["1", "2026-08-11T10:00:00.000Z"],
      ["2", "2026-08-11T10:00:00.100Z"],
      ["3", "2026-08-11T10:00:00.200Z"],
    ] as const) {
      await enqueue(database, id, time);
    }
    await work.notify("chat-1", scheduling);

    const claim = await work.claimNext(claimInput("scheduler-1", "2026-08-11T10:00:01.200Z"));
    expect(claim?.conversationId).toBe("chat-1");
    expect(claim?.items.map(({ id }) => id)).toEqual(["inbox-1", "inbox-2"]);
    const frozenInput = {
      inboxItems: [
        { inboxItemId: "inbox-1", kind: "message", referenceId: "observation-1" },
        { inboxItemId: "inbox-2", kind: "message", referenceId: "observation-2" },
      ],
    };
    const run = await database.repositories.runs.get(claim!.runId);
    expect(run?.input).toEqual(frozenInput);
    expect(run?.model).toEqual(model);
    expect(run?.status).toBe("running");
    expect(
      await work.claimNext(claimInput("scheduler-2", "2026-08-11T10:00:01.200Z")),
    ).toBeUndefined();

    await enqueue(database, "4", "2026-08-11T10:00:01.300Z");
    await work.notify("chat-1", scheduling);
    expect((await database.repositories.runs.get(claim!.runId))?.input).toEqual(frozenInput);
    expect((await database.repositories.inbox.pending("chat-1")).map(({ id }) => id)).toEqual([
      "inbox-3",
      "inbox-4",
    ]);

    await work.complete({
      runId: claim!.runId,
      leaseOwner: "scheduler-1",
      result: { summary: "handled" },
      completedAt: "2026-08-11T10:00:02.000Z",
      scheduling,
    });
    expect((await database.repositories.inbox.pending("chat-1")).map(({ id }) => id)).toEqual([
      "inbox-3",
      "inbox-4",
    ]);
    expect(await work.nextWakeAt()).toBe("2026-08-11T10:00:02.300Z");
  });
});

test("no completion is possible while tool calls remain active", async () => {
  await withDatabase(async (database) => {
    const work = database.repositories.conversationWork;
    await enqueue(database, "1", "2026-08-11T10:00:00.000Z");
    await work.notify("chat-1", scheduling);
    const claim = await work.claimNext(claimInput("scheduler-1", "2026-08-11T10:00:01.000Z"));
    const { toolCallId } = await work.beginTool({
      runId: claim!.runId,
      callId: "model-call-1",
      toolName: "recall",
      input: { query: "project" },
    });

    await expect(
      work.complete({
        runId: claim!.runId,
        leaseOwner: "scheduler-1",
        result: { summary: "too early" },
        completedAt: "2026-08-11T10:00:02.000Z",
        scheduling,
      }),
    ).rejects.toThrow("is not running");

    await work.finishTool({
      toolCallId,
      result: { outcome: "succeeded", output: { claims: [] } },
    });
    await expect(
      work.finishTool({
        toolCallId,
        result: { outcome: "failed", error: "already finished" },
      }),
    ).rejects.toThrow('cannot finish from outcome "succeeded"');
    await work.complete({
      runId: claim!.runId,
      leaseOwner: "scheduler-1",
      result: { summary: "done" },
      completedAt: "2026-08-11T10:00:03.000Z",
      scheduling,
    });

    expect((await database.repositories.runs.get(claim!.runId))?.status).toBe("succeeded");
    await expect(
      work.beginTool({
        runId: claim!.runId,
        callId: "late-call",
        toolName: "recall",
        input: {},
      }),
    ).rejects.toThrow('cannot start tool calls from status "succeeded"');
  });
});

test("failed and expired leases release exact run ranges for retry", async () => {
  await withDatabase(async (database) => {
    const work = database.repositories.conversationWork;
    await enqueue(database, "1", "2026-08-11T10:00:00.000Z");
    await work.notify("chat-1", scheduling);
    const first = await work.claimNext(
      claimInput("scheduler-1", "2026-08-11T10:00:01.000Z", { leaseMs: 1_000 }),
    );
    expect(first).toBeDefined();
    const { toolCallId } = await work.beginTool({
      runId: first!.runId,
      callId: "model-call-1",
      toolName: "recall",
      input: { query: "project" },
    });

    await expect(
      work.fail({
        runId: first!.runId,
        leaseOwner: "scheduler-2",
        error: "wrong owner",
        completedAt: "2026-08-11T10:00:01.500Z",
        scheduling,
      }),
    ).rejects.toThrow('does not have an active lease for "scheduler-2"');

    const retried = await work.claimNext(claimInput("scheduler-2", "2026-08-11T10:00:02.100Z"));
    expect(retried?.items.map(({ id }) => id)).toEqual(["inbox-1"]);
    expect((await database.repositories.runs.get(first!.runId))?.status).toBe("failed");
    expect((await database.repositories.runs.get(first!.runId))?.error).toBe(
      "conversation lease expired",
    );
    expect(await database.repositories.runs.getToolCall(toolCallId)).toMatchObject({
      outcome: "failed",
      error: "conversation lease expired",
      completedAt: "2026-08-11T10:00:02.100Z",
    });

    await work.fail({
      runId: retried!.runId,
      leaseOwner: "scheduler-2",
      error: "model unavailable",
      completedAt: "2026-08-11T10:00:03.000Z",
      scheduling,
    });
    expect((await database.repositories.inbox.pending("chat-1")).map(({ id }) => id)).toEqual([
      "inbox-1",
    ]);
  });
});

test("startup reconciliation recovers pending items that were never notified", async () => {
  await withDatabase(async (database, url) => {
    await enqueue(database, "1", "2026-08-11T10:00:00.000Z");
    await database.close();

    const reopened = await openAmbientDatabase(url);
    try {
      expect(await reopened.repositories.conversationWork.nextWakeAt()).toBeUndefined();
      await reopened.repositories.conversationWork.reconcile(scheduling);
      expect(await reopened.repositories.conversationWork.nextWakeAt()).toBe(
        "2026-08-11T10:00:01.000Z",
      );
    } finally {
      await reopened.close();
    }
  });
});

test("two scheduler connections cannot claim the same due conversation", async () => {
  await withDatabase(async (database, url) => {
    await enqueue(database, "1", "2026-08-11T10:00:00.000Z");
    await database.repositories.conversationWork.notify("chat-1", scheduling);
    const second = await openAmbientDatabase(url);
    try {
      const claims = await Promise.all([
        database.repositories.conversationWork.claimNext(
          claimInput("scheduler-1", "2026-08-11T10:00:01.000Z"),
        ),
        second.repositories.conversationWork.claimNext(
          claimInput("scheduler-2", "2026-08-11T10:00:01.000Z"),
        ),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(claims.flatMap((claim) => claim?.items.map(({ id }) => id) ?? [])).toEqual([
        "inbox-1",
      ]);
    } finally {
      await second.close();
    }
  });
});
