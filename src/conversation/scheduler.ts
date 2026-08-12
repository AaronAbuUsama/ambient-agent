import type { ModelConfig } from "../agent-models";
import type { ConversationScheduleRepository } from "../database/conversation-schedule";
import type { EvaluationRepository } from "../database/evaluations";
import type { MemoryRepository } from "../database/memory";
import type { ObservationRepository } from "../database/observations";
import type { AgentRun, RunRepository } from "../database/runs";
import { messageOf } from "../platform/errors";
import type {
  ConversationAgent,
  ConversationRunClaim,
  ConversationSchedulingConfig,
} from "./contract";
import {
  createConversationContextBuilder,
  type ConversationContextBuilder,
} from "./context-builder";

export interface ScopedMessageSender {
  sendText(input: {
    readonly conversationId: string;
    readonly text: string;
    readonly idempotencyKey: string;
  }): Promise<{ readonly operationId: string }>;
}

export interface ConversationScheduler {
  start(): Promise<void>;
  wake(conversationId?: string): Promise<void>;
  stop(): Promise<void>;
  runOnce(now?: string): Promise<"idle" | "succeeded" | "failed">;
}

export interface ConversationSchedulerOptions {
  readonly leaseOwner?: string;
  readonly agentId?: string;
  readonly promptVersion?: string;
  readonly instructions?: string;
  readonly scheduling: ConversationSchedulingConfig;
  readonly model: ModelConfig;
  readonly schedule: ConversationScheduleRepository;
  readonly observations: ObservationRepository;
  readonly memory: MemoryRepository;
  readonly runs: RunRepository;
  readonly evaluations: EvaluationRepository;
  readonly agent: ConversationAgent;
  readonly sender: ScopedMessageSender;
  readonly now?: () => Date;
}

export function createConversationScheduler(
  options: ConversationSchedulerOptions,
): ConversationScheduler {
  const leaseOwner = options.leaseOwner ?? `conversation-scheduler:${crypto.randomUUID()}`;
  const now = options.now ?? (() => new Date());
  const contextBuilder: ConversationContextBuilder = createConversationContextBuilder(
    options.observations,
    options.instructions ?? "Respond naturally and helpfully when a response is useful.",
  );
  let active = false;
  let activeRunAbort: AbortController | undefined;
  let timer: NodeJS.Timeout | undefined;
  let scheduled: Promise<void> | undefined;
  let wakePending = false;
  const pendingNotifications = new Set<string>();

  const executeTool = async <T>(
    runId: string,
    callId: string,
    toolName: string,
    input: AgentRun["input"],
    work: () => Promise<T>,
    persistedOutput: (value: T) => AgentRun["input"],
  ): Promise<T> => {
    const toolCall = await options.runs.startToolCall({
      runId,
      callId,
      toolName,
      input,
    });
    try {
      const value = await work();
      await options.runs.completeToolCall(toolCall.id, {
        outcome: "succeeded",
        output: persistedOutput(value),
      });
      return value;
    } catch (error) {
      await options.runs.completeToolCall(toolCall.id, {
        outcome: "failed",
        error: messageOf(error),
      });
      throw error;
    }
  };

  const evaluate = async (
    claim: ConversationRunClaim,
    result:
      | { readonly status: "succeeded"; readonly operationId?: string }
      | { readonly status: "failed"; readonly error: string },
  ): Promise<void> => {
    let evaluationId: string | undefined;
    try {
      const evaluation = await options.evaluations.start({
        role: "conversation",
        subjectRunId: claim.run.id,
        caseId: "conversation-contract-v1",
        configuration: {
          promptVersion: claim.run.promptVersion,
          maximumItemsPerRun: options.scheduling.maximumItemsPerRun,
        },
        startedAt: now().toISOString(),
      });
      evaluationId = evaluation.id;
      await options.evaluations.recordResult({
        evaluationRunId: evaluation.id,
        metric: "bounded_input",
        score: claim.items.length <= options.scheduling.maximumItemsPerRun ? 1 : 0,
        passed: claim.items.length <= options.scheduling.maximumItemsPerRun,
        detail: {
          itemCount: claim.items.length,
          maximumItemsPerRun: options.scheduling.maximumItemsPerRun,
        },
      });
      await options.evaluations.recordResult({
        evaluationRunId: evaluation.id,
        metric: "reply_or_silence",
        passed: result.status === "succeeded",
        detail:
          result.status === "succeeded"
            ? {
                decision: result.operationId ? "reply" : "silence",
                ...(result.operationId ? { operationId: result.operationId } : {}),
              }
            : { decision: "failed", error: result.error },
      });
      await options.evaluations.recordResult({
        evaluationRunId: evaluation.id,
        metric: "scoped_tools",
        passed: true,
        detail: {
          conversationId: claim.run.conversationId ?? null,
          destinationOwnedBy: "conversation-scheduler",
        },
      });
      await options.evaluations.finish(evaluation.id, { status: "succeeded" }, now().toISOString());
    } catch (error) {
      if (evaluationId) {
        await options.evaluations
          .finish(evaluationId, { status: "failed", error: messageOf(error) }, now().toISOString())
          .catch(() => {});
      }
    }
  };

  const executeClaim = async (claim: ConversationRunClaim): Promise<"succeeded" | "failed"> => {
    const abort = new AbortController();
    activeRunAbort = abort;
    let leaseLost: Error | undefined;
    let sendAttempted = false;
    let sendFailure: string | undefined;
    let submittedOperationId: string | undefined;
    const renewal = setInterval(
      () => {
        const renewedAt = now();
        const leaseUntil = new Date(renewedAt.getTime() + options.scheduling.leaseMs).toISOString();
        void options.schedule
          .renewLease({
            runId: claim.run.id,
            leaseOwner,
            now: renewedAt.toISOString(),
            leaseUntil,
          })
          .then((renewed) => {
            if (renewed) return;
            leaseLost = new Error(`conversation run "${claim.run.id}" lost its lease`);
            abort.abort(leaseLost);
          })
          .catch((error: unknown) => {
            leaseLost = error instanceof Error ? error : new Error(String(error));
            abort.abort(leaseLost);
          });
      },
      Math.max(1, Math.floor(options.scheduling.leaseMs / 2)),
    );

    try {
      const input = await contextBuilder.build(claim);
      const result = await options.agent.run(
        options.model,
        input,
        {
          async sendMessage(text, callId) {
            if (abort.signal.aborted) throw abort.signal.reason;
            sendAttempted = true;
            try {
              const output = await executeTool(
                claim.run.id,
                callId,
                "send_message",
                { conversationId: input.conversationId, text },
                () =>
                  options.sender.sendText({
                    conversationId: input.conversationId,
                    text,
                    idempotencyKey: `conversation:${claim.items[0]!.id}:send_message`,
                  }),
                ({ operationId }) => ({ operationId }),
              );
              submittedOperationId = output.operationId;
              return output;
            } catch (error) {
              sendFailure = messageOf(error);
              throw error;
            }
          },
          async recall(query, callId) {
            if (abort.signal.aborted) throw abort.signal.reason;
            const claims = await executeTool(
              claim.run.id,
              callId,
              "recall",
              { query },
              () =>
                options.memory.recall({
                  nativeIds: [
                    input.conversationId,
                    ...new Set(input.newMessages.map(({ senderId }) => senderId)),
                  ],
                  query,
                }),
              (recalled) => ({
                claims: recalled.map((memory) => ({
                  ...memory,
                  evidenceObservationIds: [...memory.evidenceObservationIds],
                })),
              }),
            );
            return { claims };
          },
        },
        abort.signal,
      );
      if (leaseLost) throw leaseLost;
      if (sendAttempted && !submittedOperationId) {
        throw new Error(`send_message did not succeed: ${sendFailure ?? "unknown failure"}`);
      }
      await options.schedule.succeed({
        runId: claim.run.id,
        leaseOwner,
        result: { summary: result.summary },
        completedAt: now().toISOString(),
        scheduling: options.scheduling,
      });
      await evaluate(claim, {
        status: "succeeded",
        ...(submittedOperationId ? { operationId: submittedOperationId } : {}),
      });
      return "succeeded";
    } catch (error) {
      if (!leaseLost) {
        if (submittedOperationId) {
          await options.schedule.succeed({
            runId: claim.run.id,
            leaseOwner,
            result: {
              summary: `WhatsApp operation ${submittedOperationId} was submitted before agent completion failed: ${messageOf(error)}`,
            },
            completedAt: now().toISOString(),
            scheduling: options.scheduling,
          });
          await evaluate(claim, {
            status: "succeeded",
            operationId: submittedOperationId,
          });
          return "succeeded";
        }
        try {
          await options.schedule.fail({
            runId: claim.run.id,
            leaseOwner,
            error: messageOf(error),
            completedAt: now().toISOString(),
            scheduling: options.scheduling,
          });
          await evaluate(claim, { status: "failed", error: messageOf(error) });
        } catch {
          // Expired leases are recovered by the next durable claim.
        }
      }
      return "failed";
    } finally {
      clearInterval(renewal);
      if (activeRunAbort === abort) activeRunAbort = undefined;
    }
  };

  const runOnce = async (at = now().toISOString()): Promise<"idle" | "succeeded" | "failed"> => {
    const claim = await options.schedule.claimDue({
      leaseOwner,
      now: at,
      model: options.model,
      agentId: options.agentId ?? "conversation-main",
      promptVersion: options.promptVersion ?? "conversation-v1",
      scheduling: options.scheduling,
    });
    if (!claim) return "idle";
    return executeClaim(claim);
  };

  const runCycle = async (): Promise<void> => {
    if (!active) return;
    if (timer) clearTimeout(timer);
    timer = undefined;
    const notifications = [...pendingNotifications];
    pendingNotifications.clear();
    for (const conversationId of notifications) {
      await options.schedule.notify(conversationId, options.scheduling);
    }
    while (active) {
      const result = await runOnce();
      if (result === "idle" || result === "failed") break;
    }
    if (!active) return;
    const nextWakeAt = await options.schedule.nextWakeAt();
    if (!nextWakeAt) return;
    timer = setTimeout(
      () => {
        void wake().catch(() => {});
      },
      Math.max(50, Date.parse(nextWakeAt) - Date.now()),
    );
  };

  const wake = (conversationId?: string): Promise<void> => {
    if (conversationId) pendingNotifications.add(conversationId);
    wakePending = true;
    if (scheduled) return scheduled;

    scheduled = Promise.resolve()
      .then(runCycle)
      .finally(() => {
        scheduled = undefined;
        if (!active || !wakePending) return;
        wakePending = false;
        void wake().catch(() => {});
      });
    wakePending = false;
    return scheduled;
  };

  return {
    async start() {
      if (active) return;
      active = true;
      await options.schedule.reconcile(options.scheduling);
      await wake();
    },

    wake,

    async stop() {
      active = false;
      activeRunAbort?.abort(new Error("Conversation scheduler stopped"));
      if (timer) clearTimeout(timer);
      timer = undefined;
      await scheduled;
    },

    runOnce,
  };
}
