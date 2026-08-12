/**
 * Evaluation is a cross-cutting observer of durable run evidence. It never
 * decides whether an effect occurred and never blocks the live Conversation
 * path; its failure changes nothing about the runs it observes.
 */

/** Retained facts about one terminal Conversation run, assembled for judging. */
export interface ConversationRunEvidence {
  readonly runId: string;
  readonly conversationId?: string;
  readonly status: "succeeded" | "failed";
  readonly promptVersion: string;
  readonly itemCount: number;
  /** The inbound texts the run was claimed for, in Inbox order. */
  readonly newMessages: readonly { readonly senderId: string; readonly text: string }[];
  /** The per-chat instructions frozen into the run input, when any. */
  readonly instructions?: string;
  /** The successful outbound reply, when one was sent. */
  readonly reply?: { readonly text: string; readonly operationId?: string };
  /** The private terminal summary, when the run succeeded. */
  readonly summary?: string;
  readonly error?: string;
}

/**
 * The one authoritative mutation path for the durable evaluation signal.
 *
 * Terminal run transitions insert the signal in their own transactions; this
 * store claims a pending subject under a fenced lease, assembles its retained
 * evidence, and consumes the signal once evaluation is recorded. An expired
 * lease makes the subject claimable again.
 */
export interface EvaluationWorkStore {
  claimNext(input: {
    readonly leaseOwner: string;
    readonly leaseMs: number;
    readonly now?: string;
  }): Promise<ConversationRunEvidence | undefined>;
  complete(runId: string): Promise<void>;
}

export interface JudgedMetric {
  readonly metric: string;
  readonly score?: number;
  readonly passed?: boolean;
  readonly detail: unknown;
}

/**
 * A model judge under the reserved `evaluator` role. Implementations own their
 * own agent-run evidence and return the evaluator run id that produced the
 * verdict.
 */
export interface ConversationJudge {
  judge(evidence: ConversationRunEvidence): Promise<{
    readonly evaluatorRunId: string;
    readonly metrics: readonly JudgedMetric[];
  }>;
}

/** The narrow recording port the runner needs; satisfied by the evaluations repository. */
export interface EvaluationRecorder {
  start(input: {
    readonly role: "conversation";
    readonly subjectRunId: string;
    readonly evaluatorRunId?: string;
    readonly caseId: string;
    readonly configuration: unknown;
    readonly startedAt?: string;
  }): Promise<{ readonly id: string }>;
  recordResult(input: {
    readonly evaluationRunId: string;
    readonly metric: string;
    readonly score?: number;
    readonly passed?: boolean;
    readonly detail: unknown;
  }): Promise<void>;
  finish(
    id: string,
    result:
      | { readonly status: "succeeded" }
      | { readonly status: "failed"; readonly error: string },
    completedAt?: string,
  ): Promise<unknown>;
}

export interface EvaluationService {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Claim and evaluate at most one pending subject; "idle" when none is due. */
  runOnce(now?: string): Promise<"idle" | "processed">;
}
