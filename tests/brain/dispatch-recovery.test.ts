import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { FlueObservation } from "@flue/runtime";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  configureBrainDispatchRecovery,
  observeBrainDispatch,
  wakeBrain,
  type DispatchBrain,
} from "../../packages/agents/src/brain/dispatch.ts";
import { createBrainInbox, type BrainInbox } from "../../packages/engine/src/brain/inbox.ts";
import { createConversationArchive } from "../../packages/engine/src/intake/conversation-archive.ts";
import type { ConversationArrival } from "../../packages/engine/src/intake/conversation-event.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = (): string => {
  const root = mkdtempSync(join(tmpdir(), "ambient-brain-recovery-"));
  roots.push(root);
  const databasePath = join(root, "application.sqlite");
  const archive = createConversationArchive(databasePath);
  const arrival: ConversationArrival = {
    id: "evidence:recovery",
    kind: "arrival",
    providerMessageId: "message:recovery",
    chatId: "team@g.us",
    senderId: "alice@s.whatsapp.net",
    senderName: "Alice",
    direction: "inbound",
    occurredAt: 1_000,
    payload: { live: true, isGroup: true, messageKind: "text", text: "nonce-recovery" },
  };
  archive.append(arrival);
  archive.close();
  return databasePath;
};

const openInbox = (databasePath: string, now: () => string, retryBackoffMs = () => 1_000): BrainInbox =>
  createBrainInbox(databasePath, {
    providerChatIdForSurface: () => "team@g.us",
    now,
    retryBackoffMs,
  });

const admit = (inbox: BrainInbox) =>
  inbox.admitIntent({
    sourceSurfaceId: "surface:team",
    interpretation: "Recover this exact immutable input.",
    evidenceIds: ["evidence:recovery"],
  });

const operation = (dispatchId: string, isError = false): FlueObservation =>
  ({
    v: 3,
    eventIndex: 2,
    timestamp: new Date().toISOString(),
    type: "operation",
    instanceId: "global",
    dispatchId,
    operationId: `operation:${dispatchId}`,
    operationKind: "prompt",
    durationMs: 10,
    isError,
    ...(isError ? { error: new Error("provider terminal failure") } : {}),
  }) as FlueObservation;

const recoverySettlement = (dispatchId: string): FlueObservation =>
  ({
    v: 3,
    eventIndex: 3,
    timestamp: new Date().toISOString(),
    type: "submission_settled",
    instanceId: "global",
    dispatchId,
    submissionId: dispatchId,
    outcome: "completed",
  }) as FlueObservation;

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined } as any;

describe("Brain Batch dispatch recovery", () => {
  it("fences a receipt race, honors durable backoff, and settles the same immutable Batch on retry", async () => {
    let clock = Date.parse("2026-07-26T00:00:00.000Z");
    const now = () => new Date(clock).toISOString();
    const inbox = openInbox(fixture(), now);
    const intent = admit(inbox);
    const timers: Array<() => void> = [];
    let calls = 0;
    const deliver: DispatchBrain = async () => {
      calls++;
      const dispatchId = `dispatch:race:${calls}`;
      if (calls === 1) observeBrainDispatch(operation(dispatchId));
      return { dispatchId, acceptedAt: now() };
    };
    const recovery = configureBrainDispatchRecovery(inbox, {
      deliver,
      logger,
      now: () => clock,
      setTimer: (callback) => {
        timers.push(callback);
        return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => undefined,
    });
    recovery.activate();

    const first = await wakeBrain(inbox, deliver, () => clock);
    expect(first?.id).toMatch(/^brain-batch:/u);
    expect(inbox.claimBatch()).toMatchObject({
      id: first!.id,
      intents: [intent],
      retryCount: 1,
      nextRetryAt: "2026-07-26T00:00:01.000Z",
    });
    expect(inbox.dispatchAttempts(first!.id)).toMatchObject([
      { dispatchId: "dispatch:race:1", terminalOutcome: "completed", retryCount: 0 },
    ]);

    expect(await wakeBrain(inbox, deliver, () => clock)).toMatchObject({ id: first!.id, retryCount: 1 });
    expect(calls).toBe(1);

    clock += 1_000;
    timers.shift()?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const retried = inbox.claimBatch()!;
    expect(retried).toMatchObject({
      id: first!.id,
      intents: [intent],
      retryCount: 1,
      dispatch: { dispatchId: "dispatch:race:2" },
    });

    inbox.recordSilence(retried.id, "Handled after provider recovery.");
    inbox.settleBatch(retried.id);
    observeBrainDispatch(operation("dispatch:race:2"));
    expect(inbox.dispatchAttempts(retried.id)).toMatchObject([
      { dispatchId: "dispatch:race:1", terminalOutcome: "completed" },
      { dispatchId: "dispatch:race:2", terminalOutcome: "completed" },
    ]);
    expect(inbox.dispatchAttempts(retried.id)[1]).not.toHaveProperty("nextRetryAt");
    expect(inbox.dispatchRecovery()).toEqual([]);
    await recovery.stop();
    inbox.close();
  });

  it("registers a persisted active dispatch on restart and releases it from recovery-only settlement", async () => {
    const databasePath = fixture();
    let clock = Date.parse("2026-07-26T01:00:00.000Z");
    const now = () => new Date(clock).toISOString();
    const first = openInbox(databasePath, now);
    admit(first);
    const batch = await wakeBrain(first, async () => ({ dispatchId: "dispatch:restart", acceptedAt: now() }), () => clock);
    first.close();

    const reopened = openInbox(databasePath, now);
    const recovery = configureBrainDispatchRecovery(reopened, {
      logger,
      now: () => clock,
      setTimer: () => ({ unref: () => undefined }) as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
    });
    observeBrainDispatch(recoverySettlement("dispatch:restart"));
    recovery.activate();

    expect(reopened.claimBatch()).toMatchObject({
      id: batch!.id,
      retryCount: 1,
      nextRetryAt: "2026-07-26T01:00:01.000Z",
    });
    expect(reopened.claimBatch()).not.toHaveProperty("dispatch");
    expect(reopened.dispatchAttempts(batch!.id)).toMatchObject([
      { dispatchId: "dispatch:restart", terminalOutcome: "settled" },
    ]);
    await recovery.stop();
    reopened.close();
  });

  it("registers a nonterminal dispatch even after its Batch settled", async () => {
    const databasePath = fixture();
    const now = () => "2026-07-26T01:15:00.000Z";
    const first = openInbox(databasePath, now);
    admit(first);
    const batch = await wakeBrain(
      first,
      async () => ({ dispatchId: "dispatch:settled-before-terminal", acceptedAt: now() }),
    );
    first.recordSilence(batch!.id, "Handled before Flue emitted its terminal.");
    first.settleBatch(batch!.id);
    first.close();

    const reopened = openInbox(databasePath, now);
    const recovery = configureBrainDispatchRecovery(reopened, { logger });
    observeBrainDispatch(recoverySettlement("dispatch:settled-before-terminal"));

    expect(reopened.dispatchAttempts(batch!.id)).toMatchObject([
      { dispatchId: "dispatch:settled-before-terminal", terminalOutcome: "settled" },
    ]);
    expect(reopened.dispatchRecovery()).toEqual([]);
    await recovery.stop();
    reopened.close();
  });

  it("backfills the active pre-ledger dispatch during upgrade", () => {
    const databasePath = fixture();
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE brain_batches (
        batch_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        dispatch_id TEXT,
        accepted_at TEXT,
        settled_at TEXT
      ) STRICT;
      INSERT INTO brain_batches VALUES (
        'brain-batch:legacy',
        '2026-07-26T01:30:00.000Z',
        'dispatch:legacy',
        '2026-07-26T01:30:00.000Z',
        NULL
      );
    `);
    database.close();

    const inbox = openInbox(databasePath, () => "2026-07-26T01:31:00.000Z");
    expect(inbox.dispatchAttempts("brain-batch:legacy")).toMatchObject([
      { dispatchId: "dispatch:legacy", retryCount: 0 },
    ]);
    inbox.close();
  });

  it("persists a terminal before retry activation despite long delay, restart, and unrelated event pressure", async () => {
    const databasePath = fixture();
    let clock = Date.parse("2026-07-26T01:45:00.000Z");
    const now = () => new Date(clock).toISOString();
    const first = openInbox(databasePath, now);
    const intent = admit(first);
    const batch = first.claimBatch()!;
    first.markBatchDispatched(batch.id, { dispatchId: "dispatch:pre-ready", acceptedAt: now() });
    first.close();

    const offline = openInbox(databasePath, now);
    const capture = configureBrainDispatchRecovery(offline, { logger, now: () => clock });
    observeBrainDispatch(recoverySettlement("dispatch:pre-ready"));
    for (let index = 0; index < 101; index++) {
      observeBrainDispatch(recoverySettlement(`dispatch:unrelated:${index}`));
    }
    expect(offline.dispatchAttempts(batch.id)).toMatchObject([
      { dispatchId: "dispatch:pre-ready", terminalOutcome: "settled" },
    ]);
    capture.stop();
    offline.close();

    clock += 24 * 60 * 60 * 1_000;
    const restarted = openInbox(databasePath, now);
    const timers: Array<() => void> = [];
    let calls = 0;
    const deliver: DispatchBrain = async () => {
      calls++;
      return { dispatchId: "dispatch:after-long-boot", acceptedAt: now() };
    };
    const recovery = configureBrainDispatchRecovery(restarted, {
      logger,
      now: () => clock,
      deliver,
      setTimer: (callback) => {
        timers.push(callback);
        return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => undefined,
    });
    expect(timers).toEqual([]);
    expect(await wakeBrain(restarted, deliver, () => clock)).toBeUndefined();
    expect(calls).toBe(0);
    recovery.activate();
    timers.shift()?.();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(restarted.claimBatch()).toMatchObject({
      id: batch.id,
      intents: [intent],
      dispatch: { dispatchId: "dispatch:after-long-boot" },
      retryCount: 1,
    });
    await recovery.stop();
    restarted.close();
  });

  it("shares the readiness gate across handles to the same application database", async () => {
    const databasePath = fixture();
    const now = () => "2026-07-26T01:50:00.000Z";
    const primary = openInbox(databasePath, now);
    const historicalReplay = openInbox(databasePath, now);
    admit(historicalReplay);
    let calls = 0;
    const deliver: DispatchBrain = async () => {
      calls++;
      return { dispatchId: "dispatch:shared-gate", acceptedAt: now() };
    };
    const recovery = configureBrainDispatchRecovery(primary, { logger });

    expect(await wakeBrain(historicalReplay, deliver)).toBeUndefined();
    expect(calls).toBe(0);
    recovery.activate();
    expect(await wakeBrain(historicalReplay, deliver)).toMatchObject({
      dispatch: { dispatchId: "dispatch:shared-gate" },
    });
    expect(calls).toBe(1);

    await recovery.stop();
    historicalReplay.close();
    primary.close();
  });

  it("ignores a stale terminal writer after a replacement dispatch is active", async () => {
    let clock = Date.parse("2026-07-26T02:00:00.000Z");
    const now = () => new Date(clock).toISOString();
    const inbox = openInbox(fixture(), now, () => 0);
    admit(inbox);
    const first = await wakeBrain(
      inbox,
      async () => ({ dispatchId: "dispatch:stale:1", acceptedAt: now() }),
      () => clock,
    );
    const recovery = configureBrainDispatchRecovery(inbox, {
      logger,
      now: () => clock,
      setTimer: () => ({ unref: () => undefined }) as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
    });
    recovery.activate();
    observeBrainDispatch(operation("dispatch:stale:1", true));
    expect(inbox.dispatchAttempts(first!.id)[0]).toMatchObject({
      terminalOutcome: "failed",
      terminalError: "provider terminal failure",
    });
    const second = await wakeBrain(
      inbox,
      async () => ({ dispatchId: "dispatch:stale:2", acceptedAt: now() }),
      () => clock,
    );

    expect(
      inbox.reconcileDispatchTerminal({
        batchId: first!.id,
        dispatchId: "dispatch:stale:1",
        outcome: "settled",
      }),
    ).toBeUndefined();
    expect(inbox.claimBatch()).toEqual(second);
    expect(inbox.dispatchAttempts(first!.id)).toMatchObject([
      { dispatchId: "dispatch:stale:1", terminalOutcome: "failed" },
      { dispatchId: "dispatch:stale:2" },
    ]);
    expect(inbox.dispatchAttempts(first!.id)[1]).not.toHaveProperty("terminalOutcome");
    await recovery.stop();
    inbox.close();
  });

  it("retains a terminal observed after stop and replays it into the next runtime", async () => {
    const databasePath = fixture();
    const now = () => "2026-07-26T03:00:00.000Z";
    const first = openInbox(databasePath, now);
    admit(first);
    const recovery = configureBrainDispatchRecovery(first, { logger });
    recovery.activate();
    const batch = await wakeBrain(first, async () => ({ dispatchId: "dispatch:between", acceptedAt: now() }));
    await recovery.stop();

    observeBrainDispatch(operation("dispatch:between", true));
    for (let index = 0; index < 101; index++) {
      observeBrainDispatch(recoverySettlement(`dispatch:between:unrelated:${index}`));
    }
    expect(first.dispatchAttempts(batch!.id)[0]).not.toHaveProperty("terminalOutcome");
    first.close();

    const reopened = openInbox(databasePath, now);
    const restarted = configureBrainDispatchRecovery(reopened, { logger });
    expect(reopened.dispatchAttempts(batch!.id)[0]).toMatchObject({
      dispatchId: "dispatch:between",
      terminalOutcome: "failed",
    });
    await restarted.stop();
    reopened.close();
  });

  it("replays a terminal after a transient durable reconciliation failure", async () => {
    const now = () => "2026-07-26T03:30:00.000Z";
    const inbox = openInbox(fixture(), now);
    admit(inbox);
    let failOnce = true;
    const flaky = {
      ...inbox,
      reconcileDispatchTerminal: (...args: Parameters<BrainInbox["reconcileDispatchTerminal"]>) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("transient sqlite failure");
        }
        return inbox.reconcileDispatchTerminal(...args);
      },
    } satisfies BrainInbox;
    const recovery = configureBrainDispatchRecovery(flaky, { logger });
    recovery.activate();
    const batch = await wakeBrain(flaky, async () => ({ dispatchId: "dispatch:flaky", acceptedAt: now() }));

    observeBrainDispatch(recoverySettlement("dispatch:flaky"));
    expect(inbox.dispatchAttempts(batch!.id)[0]).not.toHaveProperty("terminalOutcome");
    await recovery.stop();

    const restarted = configureBrainDispatchRecovery(inbox, { logger });
    expect(inbox.dispatchAttempts(batch!.id)[0]).toMatchObject({
      dispatchId: "dispatch:flaky",
      terminalOutcome: "settled",
    });
    await restarted.stop();
    inbox.close();
  });

  it("drains an in-flight retry receipt before stop returns", async () => {
    const now = () => "2026-07-26T04:00:00.000Z";
    const inbox = openInbox(fixture(), now, () => 0);
    admit(inbox);
    const batch = inbox.claimBatch()!;
    inbox.markBatchDispatched(batch.id, { dispatchId: "dispatch:old", acceptedAt: now() });
    inbox.reconcileDispatchTerminal({
      batchId: batch.id,
      dispatchId: "dispatch:old",
      outcome: "failed",
      error: "provider failed",
    });

    const timers: Array<() => void> = [];
    let startDelivery!: () => void;
    const deliveryStarted = new Promise<void>((resolve) => {
      startDelivery = resolve;
    });
    let finishDelivery!: (receipt: { dispatchId: string; acceptedAt: string }) => void;
    const delivery = new Promise<{ dispatchId: string; acceptedAt: string }>((resolve) => {
      finishDelivery = resolve;
    });
    const recovery = configureBrainDispatchRecovery(inbox, {
      logger,
      deliver: async () => {
        startDelivery();
        return await delivery;
      },
      setTimer: (callback) => {
        timers.push(callback);
        return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => undefined,
    });
    recovery.activate();
    timers.shift()?.();
    await deliveryStarted;

    let stopped = false;
    const stopping = recovery.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finishDelivery({ dispatchId: "dispatch:replacement", acceptedAt: now() });
    await stopping;

    expect(inbox.claimBatch()).toMatchObject({
      id: batch.id,
      dispatch: { dispatchId: "dispatch:replacement" },
    });
    inbox.close();
  });

  it("does not make stop wait for a queued wake behind another inbox handle", async () => {
    const databasePath = fixture();
    const now = () => "2026-07-26T04:30:00.000Z";
    const primary = openInbox(databasePath, now);
    const historicalReplay = openInbox(databasePath, now);
    admit(historicalReplay);
    const recovery = configureBrainDispatchRecovery(primary, { logger });
    recovery.activate();

    let startDelivery!: () => void;
    const deliveryStarted = new Promise<void>((resolve) => {
      startDelivery = resolve;
    });
    let finishDelivery!: (receipt: { dispatchId: string; acceptedAt: string }) => void;
    const delivery = new Promise<{ dispatchId: string; acceptedAt: string }>((resolve) => {
      finishDelivery = resolve;
    });
    const siblingWake = wakeBrain(historicalReplay, async () => {
      startDelivery();
      return await delivery;
    });
    await deliveryStarted;
    const queuedPrimaryWake = wakeBrain(primary, async () => {
      throw new Error("The queued primary wake must observe the closed gate.");
    });

    await recovery.stop();
    primary.close();
    const replacement = openInbox(databasePath, now);
    const replacementRecovery = configureBrainDispatchRecovery(replacement, { logger });
    replacementRecovery.activate();
    finishDelivery({ dispatchId: "dispatch:historical-replay", acceptedAt: now() });

    await expect(siblingWake).resolves.toMatchObject({
      dispatch: { dispatchId: "dispatch:historical-replay" },
    });
    await expect(queuedPrimaryWake).resolves.toBeUndefined();
    await replacementRecovery.stop();
    replacement.close();
    historicalReplay.close();
  });
});
