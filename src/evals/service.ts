import { messageOf } from "../platform/errors";
import type {
  ConversationJudge,
  ConversationRunEvidence,
  EvaluationRecorder,
  EvaluationService,
  EvaluationWorkStore,
} from "./contract";

export interface EvaluationServiceOptions {
  readonly work: EvaluationWorkStore;
  readonly recorder: EvaluationRecorder;
  /** Absent when no evaluator role is configured; contract metrics still run. */
  readonly judge?: ConversationJudge;
  readonly maximumItemsPerRun: number;
  readonly leaseOwner?: string;
  readonly leaseMs?: number;
  readonly pollMs?: number;
  readonly now?: () => Date;
}

const CONTRACT_CASE = "conversation-contract-v1";
const JUDGED_CASE = "conversation-judged-v1";

/**
 * The asynchronous evaluation runner: claims durable evaluation signals,
 * records deterministic contract metrics from retained evidence, and applies
 * the model judge when one is configured. It observes runs; it never changes
 * them, and its failures never reach the live Conversation path.
 */
export function createEvaluationService(options: EvaluationServiceOptions): EvaluationService {
  const leaseOwner = options.leaseOwner ?? `evaluation-service:${crypto.randomUUID()}`;
  const leaseMs = options.leaseMs ?? 60_000;
  const pollMs = options.pollMs ?? 5_000;
  const now = options.now ?? (() => new Date());

  const recordContract = async (evidence: ConversationRunEvidence): Promise<void> => {
    let evaluationId: string | undefined;
    const at = now().toISOString();
    try {
      const evaluation = await options.recorder.start({
        role: "conversation",
        subjectRunId: evidence.runId,
        caseId: CONTRACT_CASE,
        configuration: {
          promptVersion: evidence.promptVersion,
          maximumItemsPerRun: options.maximumItemsPerRun,
        },
        startedAt: at,
      });
      evaluationId = evaluation.id;
      await options.recorder.recordResult({
        evaluationRunId: evaluation.id,
        metric: "bounded_input",
        score: evidence.itemCount <= options.maximumItemsPerRun ? 1 : 0,
        passed: evidence.itemCount <= options.maximumItemsPerRun,
        detail: {
          itemCount: evidence.itemCount,
          maximumItemsPerRun: options.maximumItemsPerRun,
        },
      });
      await options.recorder.recordResult({
        evaluationRunId: evaluation.id,
        metric: "reply_or_silence",
        passed: evidence.status === "succeeded",
        detail:
          evidence.status === "succeeded"
            ? {
                decision: evidence.reply ? "reply" : "silence",
                ...(evidence.reply?.operationId ? { operationId: evidence.reply.operationId } : {}),
              }
            : { decision: "failed", error: evidence.error ?? "unknown" },
      });
      await options.recorder.recordResult({
        evaluationRunId: evaluation.id,
        metric: "scoped_tools",
        passed: true,
        detail: {
          ...(evidence.conversationId ? { conversationId: evidence.conversationId } : {}),
          destinationOwnedBy: "conversation-service",
        },
      });
      await options.recorder.finish(evaluation.id, { status: "succeeded" }, now().toISOString());
    } catch (error) {
      if (evaluationId) {
        await options.recorder
          .finish(evaluationId, { status: "failed", error: messageOf(error) }, now().toISOString())
          .catch(() => {});
      }
    }
  };

  const recordJudged = async (
    judge: ConversationJudge,
    evidence: ConversationRunEvidence,
  ): Promise<void> => {
    try {
      const verdict = await judge.judge(evidence);
      const evaluation = await options.recorder.start({
        role: "conversation",
        subjectRunId: evidence.runId,
        evaluatorRunId: verdict.evaluatorRunId,
        caseId: JUDGED_CASE,
        configuration: { promptVersion: evidence.promptVersion },
        startedAt: now().toISOString(),
      });
      for (const metric of verdict.metrics) {
        await options.recorder.recordResult({
          evaluationRunId: evaluation.id,
          metric: metric.metric,
          ...(metric.score === undefined ? {} : { score: metric.score }),
          ...(metric.passed === undefined ? {} : { passed: metric.passed }),
          detail: metric.detail,
        });
      }
      await options.recorder.finish(evaluation.id, { status: "succeeded" }, now().toISOString());
    } catch (error) {
      // A failed judging attempt is itself retained evidence.
      const evaluation = await options.recorder.start({
        role: "conversation",
        subjectRunId: evidence.runId,
        caseId: JUDGED_CASE,
        configuration: { promptVersion: evidence.promptVersion },
        startedAt: now().toISOString(),
      });
      await options.recorder.finish(
        evaluation.id,
        { status: "failed", error: messageOf(error) },
        now().toISOString(),
      );
    }
  };

  const runOnce = async (at?: string): Promise<"idle" | "processed"> => {
    const evidence = await options.work.claimNext({
      leaseOwner,
      leaseMs,
      ...(at === undefined ? {} : { now: at }),
    });
    if (!evidence) return "idle";
    await recordContract(evidence);
    if (options.judge && evidence.status === "succeeded") {
      await recordJudged(options.judge, evidence);
    }
    await options.work.complete(evidence.runId);
    return "processed";
  };

  let active = false;
  let timer: NodeJS.Timeout | undefined;
  let draining: Promise<void> | undefined;

  const drain = async (): Promise<void> => {
    while (active) {
      try {
        if ((await runOnce()) === "idle") return;
      } catch {
        // Evaluation is observational: a failing claim backs off to the next
        // poll instead of crashing Ambient; the lease makes it retryable.
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
      // ponytail: interval poll over an indexed pending table; move to a
      // completion-side wake hint if eval latency ever matters.
      timer = setInterval(() => void scheduleDrain(), pollMs);
      timer.unref?.();
    },

    async stop() {
      active = false;
      if (timer) clearInterval(timer);
      timer = undefined;
      await draining;
    },

    runOnce,
  };
}
