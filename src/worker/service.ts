import type { IssueAttachment } from "../github/issues";
import { messageOf } from "../platform/errors";
import type { ModelConfig } from "../models/contract";
import type {
  ComposeAssignment,
  WorkerAgent,
  WorkerAssignment,
  WorkerService,
  WorkerWorkStore,
} from "./contract";

/** The run evidence the service records; satisfied by the run repository. */
export interface WorkerRunRecorder {
  start(input: {
    readonly agentId: string;
    readonly role: "worker";
    readonly conversationId?: string;
    readonly taskId?: string;
    readonly model: ModelConfig;
    readonly promptVersion: string;
    readonly input: unknown;
  }): Promise<{ readonly id: string }>;
  finish(
    id: string,
    result:
      | { readonly status: "succeeded"; readonly result: unknown }
      | { readonly status: "failed"; readonly error: string },
  ): Promise<void>;
}

export interface WorkerServiceOptions {
  readonly work: WorkerWorkStore;
  readonly runs: WorkerRunRecorder;
  readonly agent: WorkerAgent;
  readonly compose: ComposeAssignment;
  /**
   * Resolve the assignment's attached refs to bytes. Absent in compositions
   * with no media store, which simply file reports without pictures.
   */
  readonly attachments?: (refs: readonly string[]) => Promise<readonly IssueAttachment[]>;
  /**
   * The durable return: the result becomes an inbox item in the originating
   * chat (idempotent per task), so the speaker reports it. Called for
   * successes AND parked failures — silence about a failed delegation is a
   * worse failure.
   */
  readonly returnResult: (conversationId: string, taskId: string) => Promise<void>;
  /** Failed attempts after which the assignment parks. */
  readonly maximumAttempts?: number;
  readonly leaseOwner?: string;
  readonly leaseMs?: number;
  readonly pollMs?: number;
  readonly narrate?: (
    conversationId: string,
    workerProfile: string,
    outcome: "succeeded" | "retrying" | "parked",
  ) => void;
  /**
   * Infrastructure failures — anything thrown outside a model attempt — are
   * reported here and NEVER swallowed: the lease is released for the next
   * poll and the daemon's voice says why (measured live: one transient throw
   * once parked the drain silently for a full lease).
   */
  readonly report?: (conversationId: string, workerProfile: string, error: string) => void;
}

const RECEIPT_TITLE = "issue";

export function createWorkerService(options: WorkerServiceOptions): WorkerService {
  const {
    work,
    runs,
    agent,
    compose,
    returnResult,
    maximumAttempts = 3,
    leaseOwner = "worker-service",
    leaseMs = 600_000,
    pollMs = 15_000,
    narrate,
    report,
  } = options;

  const park = async (claim: WorkerAssignment, summary: string): Promise<void> => {
    // The return is enqueued first and is idempotent per task: a crash after
    // it leaves the lease to expire and the retry to land here again.
    await returnResult(claim.conversationId, claim.id).catch(() => {});
    await work.transition(claim.id, { to: "failed", leaseOwner, resultSummary: summary });
    narrate?.(claim.conversationId, claim.workerProfile, "parked");
  };

  const runOnce = async (
    now?: string,
  ): Promise<{
    readonly outcome: "idle" | "done" | "failed";
    readonly taskId?: string;
    readonly runId?: string;
  }> => {
    const at = now ?? new Date().toISOString();
    const claim = await work.claimNext({
      workerId: leaseOwner,
      now: at,
      leaseUntil: new Date(Date.parse(at) + leaseMs).toISOString(),
    });
    if (!claim) return { outcome: "idle" };

    try {
      return await runClaim(claim);
    } catch (error) {
      // Not a model failure (those are handled inside, with attempts) — an
      // infrastructure throw. Release the lease so the next poll retries,
      // and say so out loud.
      const reason = messageOf(error);
      report?.(claim.conversationId, claim.workerProfile, reason);
      // The release itself can hit the same transient contention that got us
      // here (measured live: a swallowed release re-deadlocked the lease for
      // its full duration) — retry briefly before conceding to lease expiry.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await work.transition(claim.id, {
            to: "failed",
            leaseOwner,
            resultSummary: `infrastructure: ${reason}`,
          });
          await work.transition(claim.id, { to: "queued" });
          break;
        } catch {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
        }
      }
      return { outcome: "failed", taskId: claim.id };
    }
  };

  const runClaim = async (
    claim: WorkerAssignment,
  ): Promise<{
    readonly outcome: "done" | "failed";
    readonly taskId?: string;
    readonly runId?: string;
  }> => {
    // The retained receipt is the authority: a previous attempt may have
    // caused the effect and died before completing. Recover from the receipt
    // without running any model — GitHub is never asked.
    const receipt = (await work.listArtifacts(claim.id)).find(
      ({ title }) => title === RECEIPT_TITLE,
    );
    if (receipt) {
      await returnResult(claim.conversationId, claim.id);
      await work.transition(claim.id, {
        to: "succeeded",
        leaseOwner,
        resultSummary: `Recovered: the effect already exists (${receipt.value}).`,
      });
      narrate?.(claim.conversationId, claim.workerProfile, "succeeded");
      return { outcome: "done", taskId: claim.id };
    }

    // Composition reads the CURRENT definition and grant. A problem here is
    // deterministic — a revoked grant, a broken definition, an out-of-
    // constraint target — so retrying cannot fix it: park immediately and
    // loudly instead of burning attempts.
    const composed = compose(claim.workerProfile, claim.conversationId);
    if ("problem" in composed) {
      await park(claim, `Cannot run "${claim.workerProfile}": ${composed.problem}`);
      return { outcome: "failed", taskId: claim.id };
    }

    const definition = composed.definition;
    const run = await runs.start({
      agentId: `worker-${claim.workerProfile}`,
      role: "worker",
      conversationId: claim.conversationId,
      taskId: claim.id,
      model: agent.model,
      promptVersion: `${agent.promptVersion ?? "worker"}+${definition.name}@${definition.contentHash}`,
      input: {
        taskId: claim.id,
        objective: claim.objective,
        ...(claim.instructions === undefined ? {} : { instructions: claim.instructions }),
        ...(claim.target === undefined ? {} : { target: claim.target }),
        definition: { name: definition.name, contentHash: definition.contentHash },
      },
    });
    const { attempt } = await work.recordAttempt({ taskId: claim.id, runId: run.id });
    if (attempt > maximumAttempts) {
      await runs.finish(run.id, { status: "failed", error: "parked: attempts exhausted" });
      await park(claim, `Parked after ${attempt - 1} failed attempts.`);
      return { outcome: "failed", taskId: claim.id, runId: run.id };
    }

    try {
      // Resolve the attached evidence to bytes here, at the last moment before
      // the effect: a ref that no longer resolves must not stop the report from
      // being filed, only from claiming a picture it does not carry.
      const attachments = await options.attachments?.(claim.attachments ?? []);
      const tools = composed.bind({
        taskId: claim.id,
        target: claim.target,
        ...(attachments?.length ? { attachments } : {}),
        retainReceipt: async (effect) => {
          await work.recordArtifact({ taskId: claim.id, ...effect });
        },
      });
      const result = await agent.run(
        {
          taskId: claim.id,
          objective: claim.objective,
          instructions: claim.instructions,
          definition: {
            name: definition.name,
            instructions: definition.instructions,
            contentHash: definition.contentHash,
          },
        },
        tools,
        undefined,
      );
      await runs.finish(run.id, { status: "succeeded", result });
      await returnResult(claim.conversationId, claim.id);
      await work.transition(claim.id, {
        to: "succeeded",
        leaseOwner,
        resultSummary: result.summary,
      });
      narrate?.(claim.conversationId, claim.workerProfile, "succeeded");
      return { outcome: "done", taskId: claim.id, runId: run.id };
    } catch (error) {
      const reason = messageOf(error);
      await runs.finish(run.id, { status: "failed", error: reason }).catch(() => {});
      if (attempt >= maximumAttempts) {
        await park(claim, `Parked after ${attempt} failed attempts: ${reason}`);
      } else {
        await work.transition(claim.id, { to: "failed", leaseOwner, resultSummary: reason });
        await work.transition(claim.id, { to: "queued" });
        narrate?.(claim.conversationId, claim.workerProfile, "retrying");
      }
      return { outcome: "failed", taskId: claim.id, runId: run.id };
    }
  };

  let active = false;
  let timer: NodeJS.Timeout | undefined;
  let draining: Promise<void> | undefined;

  const drain = async (): Promise<void> => {
    while (active) {
      try {
        // A failed claim waits for the next poll instead of hot-looping.
        if ((await runOnce()).outcome !== "done") return;
      } catch (error) {
        report?.("worker", "drain", messageOf(error));
        return;
      }
    }
  };

  const scheduleDrain = (): Promise<void> => {
    draining ??= drain().finally(() => {
      draining = undefined;
    });
    return draining;
  };

  return {
    async start() {
      if (active) return;
      active = true;
      await scheduleDrain();
      timer = setInterval(() => void scheduleDrain(), pollMs);
      timer.unref?.();
    },

    async stop() {
      active = false;
      if (timer) clearInterval(timer);
      timer = undefined;
      await draining;
    },

    wake() {
      if (active) void scheduleDrain();
    },

    runOnce,
  };
}
