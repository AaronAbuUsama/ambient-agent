import { messageOf } from "../platform/errors";
import type {
  ConversationAgent,
  ConversationClaim,
  ConversationRecall,
  ConversationSchedulingConfig,
  ConversationSkill,
  ConversationWorkStore,
  ScopedMessageSender,
} from "./contract";
import {
  createConversationContextBuilder,
  type ConversationContextBuilder,
} from "./context-builder";

export interface ConversationService {
  start(): Promise<void>;
  wake(conversationId?: string): Promise<void>;
  stop(): Promise<void>;
  runOnce(now?: string): Promise<"idle" | "succeeded" | "failed">;
}

export interface ConversationServiceOptions {
  readonly leaseOwner?: string;
  readonly agentId?: string;
  readonly promptVersion?: string;
  readonly instructions?: string;
  /** The chat's granted skills, read fresh at run assembly (the files are the control). */
  readonly skills?: (conversationId: string) => Promise<readonly ConversationSkill[]>;
  readonly scheduling: ConversationSchedulingConfig;
  readonly work: ConversationWorkStore;
  readonly recall: ConversationRecall;
  readonly agent: ConversationAgent;
  readonly sender: ScopedMessageSender;
  readonly now?: () => Date;
}

export function createConversationService(
  options: ConversationServiceOptions,
): ConversationService {
  const leaseOwner = options.leaseOwner ?? `conversation-service:${crypto.randomUUID()}`;
  const promptVersion = options.promptVersion ?? "conversation-v1";
  const now = options.now ?? (() => new Date());
  const contextBuilder: ConversationContextBuilder = createConversationContextBuilder(
    options.work,
    options.instructions ?? "Respond naturally and helpfully when a response is useful.",
    options.skills,
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
    input: unknown,
    work: () => Promise<T>,
    persistedOutput: (value: T) => unknown,
  ): Promise<T> => {
    const { toolCallId } = await options.work.beginTool({ runId, callId, toolName, input });
    try {
      const value = await work();
      await options.work.finishTool({
        toolCallId,
        result: { outcome: "succeeded", output: persistedOutput(value) },
      });
      return value;
    } catch (error) {
      await options.work.finishTool({
        toolCallId,
        result: { outcome: "failed", error: messageOf(error) },
      });
      throw error;
    }
  };

  const executeClaim = async (claim: ConversationClaim): Promise<"succeeded" | "failed"> => {
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
        void options.work
          .renewLease({
            runId: claim.runId,
            leaseOwner,
            now: renewedAt.toISOString(),
            leaseUntil,
          })
          .then((renewed) => {
            if (renewed) return;
            leaseLost = new Error(`conversation run "${claim.runId}" lost its lease`);
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
        input,
        {
          async sendMessage(text, callId) {
            if (abort.signal.aborted) throw abort.signal.reason;
            sendAttempted = true;
            try {
              const output = await executeTool(
                claim.runId,
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
              claim.runId,
              callId,
              "recall",
              { query },
              () =>
                options.recall.recall({
                  nativeIds: [
                    input.conversationId,
                    ...new Set(input.newMessages.map(({ senderId }) => senderId)),
                  ],
                  query,
                }),
              (recalled) => ({ claims: recalled }),
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
      await options.work.complete({
        runId: claim.runId,
        leaseOwner,
        result: { summary: result.summary },
        completedAt: now().toISOString(),
        scheduling: options.scheduling,
      });
      return "succeeded";
    } catch (error) {
      if (!leaseLost) {
        if (submittedOperationId) {
          await options.work.complete({
            runId: claim.runId,
            leaseOwner,
            result: {
              summary: `WhatsApp operation ${submittedOperationId} was submitted before agent completion failed: ${messageOf(error)}`,
            },
            completedAt: now().toISOString(),
            scheduling: options.scheduling,
          });
          return "succeeded";
        }
        try {
          await options.work.fail({
            runId: claim.runId,
            leaseOwner,
            error: messageOf(error),
            completedAt: now().toISOString(),
            scheduling: options.scheduling,
          });
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
    const claim = await options.work.claimNext({
      leaseOwner,
      now: at,
      model: options.agent.model,
      agentId: options.agentId ?? "conversation-main",
      promptVersion,
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
      await options.work.notify(conversationId, options.scheduling);
    }
    while (active) {
      const result = await runOnce();
      if (result === "idle" || result === "failed") break;
    }
    if (!active) return;
    const nextWakeAt = await options.work.nextWakeAt();
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
      await options.work.reconcile(options.scheduling);
      await wake();
    },

    wake,

    async stop() {
      active = false;
      activeRunAbort?.abort(new Error("Conversation service stopped"));
      if (timer) clearTimeout(timer);
      timer = undefined;
      await scheduled;
    },

    runOnce,
  };
}
