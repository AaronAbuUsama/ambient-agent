import type { MediaInterpreter } from "../media/contract";
import { messageOf } from "../platform/errors";
import type {
  ConversationAgent,
  ConversationClaim,
  ConversationDelegate,
  ConversationRecall,
  ConversationSchedulingConfig,
  ConversationSkill,
  ConversationTaskUpdate,
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
  /** The chat's granted agents, composed fresh at run assembly. */
  readonly agents?: (conversationId: string) => Promise<readonly ConversationDelegate[]>;
  /** Dereference task_update inbox items to their assignments' outcomes. */
  readonly taskUpdates?: (taskIds: readonly string[]) => Promise<readonly ConversationTaskUpdate[]>;
  /**
   * Open one assignment for a granted agent. The host behind this validates
   * the grant and the target and adopts on the derived id; the service only
   * supplies this run's provenance and idempotency key.
   */
  readonly delegate?: (input: {
    readonly conversationId: string;
    readonly requestedByRunId: string;
    readonly agent: string;
    readonly objective: string;
    readonly target?: string | undefined;
    readonly attachments?: readonly string[] | undefined;
    readonly idempotencyKey: string;
  }) => Promise<{ readonly taskId: string; readonly outcome: "created" | "adopted" }>;
  readonly scheduling: ConversationSchedulingConfig;
  readonly work: ConversationWorkStore;
  readonly recall: ConversationRecall;
  /** Absent when no vision model is configured; view_image then declines. */
  readonly media?: MediaInterpreter;
  readonly agent: ConversationAgent;
  readonly sender: ScopedMessageSender;
  readonly now?: () => Date;
}

export function createConversationService(
  options: ConversationServiceOptions,
): ConversationService {
  const leaseOwner = options.leaseOwner ?? `conversation-service:${crypto.randomUUID()}`;
  const promptVersion = options.promptVersion ?? "conversation-v3";
  const now = options.now ?? (() => new Date());
  const contextBuilder: ConversationContextBuilder = createConversationContextBuilder(
    options.work,
    options.instructions ?? "Respond naturally and helpfully when a response is useful.",
    {
      ...(options.skills ? { skills: options.skills } : {}),
      ...(options.agents ? { agents: options.agents } : {}),
      ...(options.taskUpdates ? { taskUpdates: options.taskUpdates } : {}),
    },
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
    let delegated = false;
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
          async delegate(request, callId) {
            if (abort.signal.aborted) throw abort.signal.reason;
            const provider = options.delegate;
            if (!provider) throw new Error("delegation is not available in this deployment");
            // One delegation per run: the idempotency key derives from this
            // claim's first item, which is stable across a retried run — the
            // retry adopts the original assignment instead of opening a second.
            if (delegated) throw new Error("delegate can only be called once per Conversation run");
            delegated = true;
            return executeTool(
              claim.runId,
              callId,
              "delegate",
              {
                agent: request.agent,
                objective: request.objective,
                target: request.target,
                attachments: request.attachments,
              },
              () =>
                provider({
                  conversationId: claim.conversationId,
                  requestedByRunId: claim.runId,
                  agent: request.agent,
                  objective: request.objective,
                  target: request.target,
                  attachments: request.attachments,
                  idempotencyKey: `conversation:${claim.items[0]!.id}:delegate`,
                }),
              (opened) => opened,
            );
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
                  conversationId: claim.conversationId,
                  nativeIds: [
                    input.conversationId,
                    ...new Set(input.newMessages.map(({ senderId }) => senderId)),
                  ],
                  query,
                  limit: 60,
                }),
              (recalled) => ({ claims: recalled }),
            );
            return { claims };
          },
          async viewImage(ref, callId) {
            if (abort.signal.aborted) throw abort.signal.reason;
            return executeTool(
              claim.runId,
              callId,
              "view_image",
              { ref },
              async () => {
                if (!options.media) return { unavailable: "no vision model is configured" };
                // Scope first: a ref names a blob in a store shared by every
                // chat, so the host decides what this run may look at.
                const carried = await options.recall.findMedia({
                  conversationId: claim.conversationId,
                  ref,
                });
                if (!carried) return { unavailable: "that media is not part of this conversation" };
                const described = await options.media.describe([{ ref, ...carried }]);
                const found = described.get(ref);
                return found?.status === "described"
                  ? { description: found.description }
                  : { unavailable: found?.failureReason ?? "it could not be interpreted" };
              },
              (result) => result,
            );
          },
          async searchHistory(query, callId) {
            if (abort.signal.aborted) throw abort.signal.reason;
            const messages = await executeTool(
              claim.runId,
              callId,
              "search_history",
              { query },
              () =>
                options.recall.searchHistory({
                  conversationId: claim.conversationId,
                  query,
                }),
              (found) => ({ messages: found }),
            );
            return { messages };
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
