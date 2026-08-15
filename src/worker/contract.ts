import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ModelConfig } from "../models/contract";
import type { ComposedAgent } from "./tools";

/**
 * The Worker role: one bounded objective, one terminal result, under a
 * fenced lease. Worker is the HARNESS — what wakes it, what it receives,
 * how it completes. The brains are agent definitions on disk; any
 * definition runs under this one contract.
 */

/** One bounded objective, immutable for the run. */
export interface WorkerInput {
  readonly taskId: string;
  readonly objective: string;
  /** Assignment-level guidance from the delegator, beyond the objective. */
  readonly instructions?: string | undefined;
  /** The definition whose craft and tools this run executes. */
  readonly definition: {
    readonly name: string;
    readonly instructions: string;
    readonly contentHash: string;
  };
}

export interface WorkerResult {
  readonly summary: string;
}

/**
 * The Worker agent runs with tools already bound to its one assignment.
 * The tools arrive prepared by the worker's own toolbox; the agent never
 * sees a destination axis, a registry, or a grant.
 */
export interface WorkerAgent {
  readonly model: ModelConfig;
  readonly promptVersion?: string;
  run(
    input: WorkerInput,
    tools: readonly AgentTool[],
    signal: AbortSignal | undefined,
  ): Promise<WorkerResult>;
}

/** The claim view of one assignment — the port the task store satisfies. */
export interface WorkerAssignment {
  readonly id: string;
  readonly conversationId: string;
  readonly objective: string;
  readonly instructions?: string | undefined;
  readonly workerProfile: string;
  readonly target?: string | undefined;
  /** Media refs the delegating speaker attached as evidence. */
  readonly attachments?: readonly string[] | undefined;
}

export interface WorkerReceipt {
  readonly kind: "text" | "file" | "url" | "json";
  readonly title: string;
  readonly value: string;
}

/**
 * The durable transitions the Worker service needs; satisfied by the task
 * repository. One authoritative mutation path — the service never touches
 * rows another store owns.
 */
export interface WorkerWorkStore {
  claimNext(input: {
    readonly workerId: string;
    readonly now?: string;
    readonly leaseUntil: string;
  }): Promise<WorkerAssignment | undefined>;
  transition(
    id: string,
    update:
      | {
          readonly to: "succeeded" | "failed";
          readonly leaseOwner: string;
          readonly at?: string;
          readonly resultSummary?: string;
        }
      | { readonly to: "queued"; readonly at?: string },
  ): Promise<unknown>;
  recordArtifact(input: {
    readonly taskId: string;
    readonly kind: WorkerReceipt["kind"];
    readonly title: string;
    readonly value: string;
  }): Promise<unknown>;
  listArtifacts(taskId: string): Promise<readonly WorkerReceipt[]>;
  recordAttempt(input: {
    readonly taskId: string;
    readonly runId: string;
  }): Promise<{ readonly attempt: number }>;
}

/**
 * Composition resolves the assignment's profile to a composed agent under
 * the ORIGINATING chat's current grant — read fresh at claim, so a revoked
 * grant or a narrowed definition stops the run rather than being grand-
 * fathered in.
 */
export interface ComposeAssignment {
  (workerProfile: string, conversationId: string): ComposedAgent | { readonly problem: string };
}

export interface WorkerService {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** A wake hint after a new delegation; never the authority. */
  wake(): void;
  runOnce(now?: string): Promise<{
    readonly outcome: "idle" | "done" | "failed";
    readonly taskId?: string;
    readonly runId?: string;
  }>;
}
