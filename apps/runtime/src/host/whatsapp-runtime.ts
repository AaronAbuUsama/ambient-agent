import { Cause, Clock, Effect, Exit, Fiber, Layer, type Scope } from "effect";
import type { MessageRef, WhatsAppSession } from "whatsappd";

import {
  configureHistoricalReplayGate,
  dispatchSpeaker,
  makeSpeakerWindowDispatcher,
  type DispatchSpeaker,
} from "@ambient-agent/agents/speaker/dispatch.ts";
import { configureIntentEscalationRuntime } from "@ambient-agent/agents/capabilities/intent-escalation/runtime.ts";
import { configureDirectiveDeliveryRuntime } from "@ambient-agent/agents/capabilities/directive-delivery/runtime.ts";
import { configureDelegationRuntime } from "@ambient-agent/agents/capabilities/delegation/runtime.ts";
import { reconcileSpecialistWorkAtBoot } from "@ambient-agent/agents/capabilities/delegation/bridge.ts";
import { recoverPendingSpecialistLaunches } from "@ambient-agent/agents/capabilities/delegation/tools.ts";
import { coderSpecialistSpec } from "@ambient-agent/agents/capabilities/coder/workflow.ts";
import { reviewerSpecialistSpec } from "@ambient-agent/agents/capabilities/reviewer/workflow.ts";
import { wakeBrain } from "@ambient-agent/agents/brain/dispatch.ts";
import {
  configureBrainEffectsRuntime,
  recoverPendingIssueFilings,
  recoverPendingIssueMutations,
  recoverPendingPrompts,
} from "@ambient-agent/agents/brain/effects-runtime.ts";
import { createIssueFiler } from "@ambient-agent/agents/brain/issue-filing.ts";
import { createIssueMutator } from "@ambient-agent/agents/brain/issue-mutation.ts";
import { getIssueManagementRuntime } from "@ambient-agent/agents/capabilities/issue-management/runtime.ts";
import { tryGetGraphStore } from "@ambient-agent/agents/capabilities/graph/runtime.ts";
import { configureScribeInbox } from "@ambient-agent/agents/scribe/coalescer.ts";
import { getRun, invoke } from "@flue/runtime";
import historicalReplayWorkflow from "../workflows/historical-replay.ts";
import type { SpeakerDispatchEvent, SpeakerObserver } from "@ambient-agent/agents/speaker/observer.ts";
import {
  configureWhatsAppParticipationPort,
  type WhatsAppHistoryPort,
  type WhatsAppMessageLookupPort,
  type WhatsAppOutboundPort,
  type WhatsAppDeliveryResult,
  withTypingResult,
} from "@ambient-agent/agents/capabilities/whatsapp-participation/whatsapp-port.ts";
import { makeManagedChatGate, type ChatGate } from "@ambient-agent/engine/coalescer/chat-gate.ts";
import * as Coalescer from "@ambient-agent/engine/coalescer/coalescer.ts";
import { configLayer, type CoalescerConfigValues } from "@ambient-agent/engine/coalescer/config.ts";
import {
  botIdsOf,
  WhatsAppEventSourceTerminalError,
  whatsappEventSource,
} from "@ambient-agent/engine/coalescer/whatsapp.ts";
import { createConversationArchive } from "@ambient-agent/engine/intake/conversation-archive.ts";
import { createBrainInbox } from "@ambient-agent/engine/brain/inbox.ts";
import { configureGitHubUpInbox } from "@ambient-agent/engine/github/up-inbox.ts";
import { createHistoricalReplayStore } from "@ambient-agent/engine/intake/historical-replay.ts";
import { createScribeInbox } from "@ambient-agent/engine/scribe/inbox.ts";
import {
  createManagedChatInbox,
  managedChatWindowStore,
  type ManagedChatInbox,
} from "@ambient-agent/engine/intake/managed-chat-inbox.ts";
import { speakerActivity } from "@ambient-agent/agents/speaker/activity-reporter.ts";
import { effectLoggerLayer, getLogger, upstreamWhatsAppLogger } from "@ambient-agent/engine/logging/logging.ts";
import type { WhatsAppRuntimePhase, WhatsAppRuntimeStatus } from "@ambient-agent/installation/runtime-health.ts";
import type { OperatorEvent } from "@ambient-agent/engine/logging/operator-reporter.ts";
import { errorMessage } from "@ambient-agent/engine/shared/errors.ts";
import {
  publishPairingProgress,
  publishPairingSettled,
  reportedWhatsAppStatus,
  transportObservation,
  whatsAppObservationOf,
  whatsAppStatusUpdate,
  whatsappObservation,
  type TransportObservation,
  type WhatsAppLiveness,
} from "@ambient-agent/installation/observation.ts";
import { isGroupJid } from "@ambient-agent/engine/shared/whatsapp-jid.ts";
import { createSurfaceRegistry, type SurfaceRegistry } from "@ambient-agent/engine/surfaces/registry.ts";
import type { GraphStore } from "@ambient-agent/engine/graph/store.ts";
import { createSurfaceDeliveryStore } from "@ambient-agent/engine/surfaces/delivery.ts";
import {
  createWhatsAppAccount,
  WhatsAppAccountError,
  type ChatCandidate,
} from "@ambient-agent/installation/whatsapp-account.ts";

const isKnownTransportRejection = (message: string): boolean => /^not online \(phase: [^)]+\)$/.test(message);
const deliveryFailure = (
  cause: unknown,
): { readonly delivery: "failed" | "unknown"; readonly deliveryError: string } => {
  const deliveryError = errorMessage(cause);
  return { delivery: isKnownTransportRejection(deliveryError) ? "failed" : "unknown", deliveryError };
};
const TYPING_LEAD_MS = 750;

/**
 * The reported phase, as an operator-feed event (#374).
 *
 * Total over the phase union rather than `Partial`, so a future phase is a compile error here
 * instead of a transition nobody is told about. The `undefined` arms are deliberate:
 *
 * - `disabled` and `starting` are boot, which the feed already narrates with its own `agent.online`
 *   line once participation is wired. (After boot, `starting` cannot occur — a booted runtime whose
 *   transport is reconnecting reports `degraded`, see `whatsappLiveness`.)
 * - `pairing` is **deliberately** not on the feed: pairing material rides the `setup` observation
 *   channel precisely so that a QR or a pairing code never lands in a log file.
 * - `stopped` is runtime-owned and published after this subscription is torn down, so it could
 *   never arrive here; the runtime's own stop path is where an operator learns it stopped.
 */
const OPERATOR_EVENT_FOR_PHASE: Record<WhatsAppRuntimePhase, OperatorEvent | undefined> = {
  disabled: undefined,
  starting: undefined,
  pairing: undefined,
  online: "agent.online",
  degraded: "agent.degraded",
  failed: "agent.offline",
  stopped: undefined,
};

/**
 * Resolve a Brain-chosen target entity to its Surface id (§8: "DM someone" and "reply in the group"
 * share one prompt operation, resolved through the ordinary Surface registry during prompt admission).
 *
 * A `thread` is an operator-authorized group: it resolves only to an already-active Surface, so a merely
 * discovered/observed group never gains participation. A known `person` is a deliberate Brain reach: their
 * DM Surface is opened on demand (find-or-create). Any other entity type — or an entity with no WhatsApp
 * identity, or an unknown id — is not an addressable Surface and returns undefined, and the Brain stays
 * silent. This is the fail-closed boundary: only a Person the coworker already knows (a Graph entity met in
 * an authorized surface) is DM-addressable; an unknown DMer has no entity here and so grants no participation.
 *
 * Materialization is atomic with admission (§8): opening a person's DM Surface is a side effect that must
 * NOT outlive a failed prompt admission, or the intake gate would then admit that chat with no accepted
 * Prompt Effect behind it. So `release` undoes a DM binding this call newly opened (retiring it), while
 * leaving an already-active DM (a live channel from a prior turn) untouched. The caller invokes `release`
 * only if recordPrompt rejects.
 */
export interface ResolvedTargetSurface {
  readonly surfaceId: string;
  readonly release: () => void;
}

const NO_RELEASE = () => undefined;

export const resolveEntitySurface = (
  deps: {
    readonly graph: Pick<GraphStore, "getEntity" | "whatsappExternalId">;
    readonly surfaces: Pick<SurfaceRegistry, "activeSurface" | "activateDirect" | "retireDirect">;
    readonly accountJid: string;
  },
  entityId: string,
): ResolvedTargetSurface | undefined => {
  const entity = deps.graph.getEntity(entityId);
  if (entity === undefined) return undefined;
  const chatId = deps.graph.whatsappExternalId(entityId);
  if (chatId === undefined) return undefined;
  if (entity.type === "thread") {
    const surface = deps.surfaces.activeSurface(deps.accountJid, chatId);
    return surface === undefined ? undefined : { surfaceId: surface.id, release: NO_RELEASE };
  }
  if (entity.type === "person") {
    // A person's WhatsApp identity must be a direct chat. If a data-quality edge case links a person to a
    // group JID, refuse to open it as a DM — otherwise activateDirect would let an unconfigured group
    // participate through the person path (the admit gate honors any active binding). Fail closed instead.
    if (isGroupJid(chatId)) return undefined;
    const alreadyLive = deps.surfaces.activeSurface(deps.accountJid, chatId) !== undefined;
    const surface = deps.surfaces.activateDirect(deps.accountJid, chatId);
    return {
      surfaceId: surface.id,
      release: alreadyLive ? NO_RELEASE : () => deps.surfaces.retireDirect(deps.accountJid, chatId),
    };
  }
  return undefined;
};

/** The sole real implementation behind Speaker's outbound participation tools. */
export const createWhatsAppHost = (
  session: WhatsAppSession,
  lookupMessage: (chatId: string, messageId: string) => MessageRef | undefined,
): WhatsAppOutboundPort => ({
  say: async (chatId, text, replyTo) => {
    const log = getLogger("whatsapp");
    const quote = replyTo === undefined ? undefined : lookupMessage(chatId, replyTo);
    if (replyTo !== undefined && quote === undefined) {
      return withTypingResult({
        delivery: "failed",
        deliveryError: `WhatsApp message ${replyTo} is not available in ${chatId}.`,
      });
    }
    let typingStarted = false;
    try {
      await session.setTyping(chatId, true);
      typingStarted = true;
    } catch (cause) {
      log.warn({ chatId, error: errorMessage(cause) }, "Typing-on failed before a WhatsApp reply");
    }

    if (typingStarted) await new Promise((resolve) => setTimeout(resolve, TYPING_LEAD_MS));

    let delivery: WhatsAppDeliveryResult;
    let typingError: string | undefined;
    try {
      try {
        const message = await session.send(chatId, { text }, quote === undefined ? undefined : { quote });
        delivery = { delivery: "sent", messageId: message.id };
        if (!speakerActivity.spokeForChat(chatId, text, message.id)) {
          log.info(
            { operatorEvent: "agent.say", text, chatId, messageId: message.id },
            "Speaker said a WhatsApp message",
          );
        }
      } catch (cause) {
        delivery = deliveryFailure(cause);
        log.error({ chatId, error: delivery.deliveryError }, `WhatsApp reply delivery ${delivery.delivery}`);
      }
    } finally {
      try {
        await session.setTyping(chatId, false);
        log.debug({ chatId }, "WhatsApp typing indicator cleared");
      } catch (cause) {
        typingError = errorMessage(cause);
        log.warn({ chatId, error: typingError }, "WhatsApp typing indicator state is unknown");
      }
    }
    return withTypingResult(delivery, typingError);
  },
  react: async (chatId, messageId, emoji) => {
    const target = lookupMessage(chatId, messageId);
    if (target === undefined) {
      return {
        delivery: "failed",
        deliveryError: `WhatsApp message ${messageId} is not available in ${chatId}.`,
      };
    }
    try {
      const message = await session.send(chatId, { react: { to: target, emoji } });
      getLogger("whatsapp").info(
        { operatorEvent: "agent.react", emoji, chatId, targetMessageId: messageId },
        "Speaker reacted to a WhatsApp message",
      );
      return { delivery: "sent", messageId: message.id };
    } catch (cause) {
      const delivery = deliveryFailure(cause);
      getLogger("whatsapp").error(
        { chatId, error: delivery.deliveryError },
        `WhatsApp reaction delivery ${delivery.delivery}`,
      );
      return delivery;
    }
  },
});

export interface WhatsAppSessionRuntimeOptions {
  readonly gate: ChatGate;
  readonly history: WhatsAppHistoryPort & WhatsAppMessageLookupPort;
  readonly inbox: ManagedChatInbox;
  readonly dispatch?: DispatchSpeaker;
  readonly coalescer?: Partial<CoalescerConfigValues>;
  readonly botLid?: string;
  /**
   * Invoked once, synchronously, right after the WhatsApp participation port is wired —
   * the seam the delegation boot sweep hangs on, so its `interrupted` notifications can
   * actually be voiced (the Speaker's `say` needs the port). Errors are the callback's own.
   */
  readonly afterParticipationReady?: () => void | Promise<void>;
}

/** Shared production/test seam: one full-fidelity whatsappd session -> retained Coalescer -> Speaker dispatch. */
export const runWhatsAppSession = (
  session: WhatsAppSession,
  options: WhatsAppSessionRuntimeOptions,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const outbound = createWhatsAppHost(session, (chatId, messageId) => {
      const message = options.history.messageState(chatId, messageId);
      return message === undefined
        ? undefined
        : {
            id: message.id,
            chatId: message.chatId,
            fromMe: message.direction === "outbound",
            ...(isGroupJid(message.chatId) && message.senderId !== undefined ? { participant: message.senderId } : {}),
          };
    });
    yield* Effect.sync(() =>
      configureWhatsAppParticipationPort({
        say: outbound.say,
        react: outbound.react,
        readThread: (chatId, limit) => options.history.readThread(chatId, limit),
        search: (chatId, query, limit) => options.history.search(chatId, query, limit),
      }),
    );
    if (options.afterParticipationReady !== undefined) {
      yield* Effect.promise(() => Promise.resolve(options.afterParticipationReady!()));
    }
    const botIds = botIdsOf(session, options.botLid);
    yield* Coalescer.run.pipe(
      Effect.provide(
        Layer.mergeAll(
          whatsappEventSource(session, options.gate.allowed, {
            replay: () => options.inbox.unwindowed(),
            accepted: (event) => options.inbox.pending(event),
          }),
          makeSpeakerWindowDispatcher(options.inbox, options.dispatch),
          managedChatWindowStore(options.inbox),
          configLayer({ ...options.coalescer, botIds }),
        ),
      ),
    );
  });

// The reported runtime phase now lives on the observation seam (#386) rather than in a private
// process-global slot. Same value, same consumers — but held where a browser can pull a snapshot
// and subscribe to deltas, instead of being written to a field only `/health` knew how to find.
const setRuntimeStatus = (status: WhatsAppRuntimeStatus): void => {
  // What this records is the runtime's own startup fact, and *only* that. Liveness is carried
  // forward rather than derived here: the projection re-derives it from the live transport on the
  // very next read, and deriving it here — necessarily without the transport — would stamp `since`
  // from a phase that was never true, resetting the operator's "degraded for how long" on every
  // status write. See LIVENESS_SINCE in observation.ts.
  const channel = whatsappObservation();
  channel.publish(whatsAppStatusUpdate(channel.snapshot().value, status));
};

/**
 * The reported WhatsApp status — the startup record with its phase replaced by derived liveness
 * (#374). Every existing consumer (`/health` via `bridgeHealth`, the bridge pairing route, the CLI
 * smoke gate, `ambient-agent doctor`) reads this one function, so all of them stopped lying at once
 * and none of them had to learn a new shape.
 */
export const getWhatsAppRuntimeStatus = (): WhatsAppRuntimeStatus =>
  structuredClone(reportedWhatsAppStatus(whatsappObservation().snapshot().value));

/** The full liveness vocabulary, for a caller that wants more than a phase. */
export const getWhatsAppLiveness = (): WhatsAppLiveness =>
  structuredClone(whatsappObservation().snapshot().value.liveness);

export interface WhatsAppRuntimeControl {
  readonly stop: () => Promise<void>;
  /**
   * Live-reload the managed-chat authorization gate in place (#179): the newly added chats engage the
   * gate with no restart and the WhatsApp stream is untouched. Only the authorization Set changes —
   * the session, model, and port are restart-only and are never reached from here.
   */
  readonly reloadManagedChats: (chatIds: readonly string[]) => void;
  readonly synchronizedChats: () => Promise<readonly ChatCandidate[]>;
  readonly smokeCanary: (
    nonce: string,
    timeoutMillis: number,
  ) => Promise<{
    readonly chatId: string;
    readonly text: string;
    readonly stages: readonly ["admission", "dispatch", "settled-silent"];
  }>;
}

export type WhatsAppSmokeCanaryStatus = 400 | 409 | 503 | 504;

export class WhatsAppSmokeCanaryError extends Error {
  override readonly name = "WhatsAppSmokeCanaryError";

  constructor(
    readonly status: WhatsAppSmokeCanaryStatus,
    message: string,
  ) {
    super(message);
  }
}

export interface WhatsAppRuntimeOptions {
  readonly storeDirectory: string;
  readonly applicationDatabase: string;
  readonly managedChats: readonly string[];
  readonly canaryChat?: string;
  readonly botLid?: string;
  /** Test seams only: a fake session and a captured exit instead of process.exit. */
  readonly sessionFactory?: () => WhatsAppSession;
  readonly exit?: (code: number) => void;
  readonly dispatch?: DispatchSpeaker;
  readonly coalescer?: Partial<CoalescerConfigValues>;
  readonly observeActivity?: (observer: SpeakerObserver) => () => void;
  /** Test seam: drive the runtime's Effect debounce boundary without wall-clock polling. */
  readonly clock?: Clock.Clock;
  /** Run once after the participation port is wired — e.g. the delegation boot sweep. */
  readonly afterParticipationReady?: () => void;
  /** The proactive clock's cron-floor cadence (§6). Default 5 min; 0 disables the interval (boot sweep only). */
  readonly proactiveClockIntervalMs?: number;
}

// ponytail: a single fixed process interval is the whole cron floor — the DB is the source of truth and
// boot reconciles, so a missed tick only delays, never drops. Per-wake precise timers only if latency bites.
const DEFAULT_PROACTIVE_CLOCK_INTERVAL_MS = 5 * 60 * 1_000;

export const startWhatsAppRuntime = (options: WhatsAppRuntimeOptions): WhatsAppRuntimeControl => {
  const storeDir = options.storeDirectory;
  const gate = makeManagedChatGate(options.managedChats);
  const archive = createConversationArchive(options.applicationDatabase);
  const surfaces = createSurfaceRegistry(options.applicationDatabase);
  // Intake admission: a chat reaches the loop if it is operator-configured (the static gate) OR the Brain
  // deliberately opened its Surface — a known-Person DM via activateDirect (S5) — so a DM the coworker
  // started is genuinely two-way, not send-only. Everything else stays fail-closed: an unconfigured group
  // and an unknown person's unsolicited DM have no active binding, so admit is false for them.
  // ponytail: authenticatedJid is unknown until authenticate resolves, so a reply to an already-open DM
  // that arrives in the brief pre-auth sync/replay window is archived but not proactively dispatched (admit
  // sees no account yet). Narrow and non-lossy — the next live message re-triggers it. Seed the jid from
  // prior bindings only if this gap ever bites; that path must not defeat the account-change retirement.
  //
  // `authenticatedJid` is the single account var (set once online); a live gate reload also needs it to
  // activate a new chat's Surface (#179). Undefined until online, so a reload before pairing only opens the
  // gate — as intended.
  let authenticatedJid: string | undefined;
  const admit = (chatId: string, isGroup: boolean): boolean =>
    gate.allowed(chatId, isGroup) ||
    (authenticatedJid !== undefined && chatId.trim() !== "" && surfaces.activeSurface(authenticatedJid, chatId) !== undefined);
  const brainInbox = createBrainInbox(options.applicationDatabase, {
    providerChatIdForSurface: (surfaceId) => surfaces.activeBinding(surfaceId)?.providerChatId,
  });
  // GitHub events flow UP into the single Brain up-inbox (§4). Admission is the durable step and is
  // always safe. Waking the Brain is gated on `brainReady`: dispatching a Batch before the Brain's
  // Effects/participation runtime exists would mark the Batch dispatched, then fail its tools, and the
  // wake-guard would never re-dispatch it — a wedge. Until ready, admitted events wait for the boot
  // sweep in afterParticipationReady (which wakes once everything is configured); after ready, each
  // admission wakes directly.
  let brainReady = false;
  let proactiveClockTimer: ReturnType<typeof setInterval> | undefined;
  // The cron/boot due scan (§6): admit a coalesced Proactive Sweep + every due Scheduled Wake, then wake.
  // Idempotent and durable — safe on boot and on every tick. Always wake, even when the scan admitted
  // nothing new: wakeBrain re-claims and re-dispatches an already-open Batch (its claimBatch returns the
  // open Batch first), so a Batch left claimed-but-undispatched by a prior transient wake failure is
  // retried here instead of wedging the clock. Non-fatal by design: a wake we cannot dispatch now (like a
  // boot issue-filing) must never kill the runtime fiber — the durable rows persist and retry next tick.
  const runProactiveClock = async (): Promise<void> => {
    try {
      brainInbox.runProactiveClock();
      await wakeBrain(brainInbox);
    } catch (cause) {
      getLogger("brain").warn(
        { event: "brain.proactive-clock.failed", error: errorMessage(cause) },
        "Proactive clock tick could not dispatch; left durable to retry next tick",
      );
    }
  };
  // Flipped false when this runtime tears down (fiber failure, reconnect, logged_out) while the HTTP app
  // may keep serving. Without it the port's captured brainInbox is a finalized SQLite handle: admit would
  // throw, the ingress would settle 'failed' → 200, and the delivery would be lost with no retry. Deferring
  // (undefined → 503) lets GitHub redeliver to the next live runtime instead.
  let brainAlive = true;
  configureGitHubUpInbox(async (event) => {
    if (!brainAlive) return undefined;
    const admitted = brainInbox.admitGitHubEvent(event);
    if (brainReady) {
      void wakeBrain(brainInbox).catch((cause) =>
        getLogger("github").error({ event: "github.up-inbox.wake-failed", error: errorMessage(cause) }, "wake"),
      );
    }
    return { id: admitted.id, admittedAt: admitted.admittedAt };
  });
  const deliveries = createSurfaceDeliveryStore(options.applicationDatabase, {
    providerChatIdForSurface: (surfaceId) => surfaces.activeBinding(surfaceId)?.providerChatId,
  });
  configureDirectiveDeliveryRuntime({ deliveries });
  const historicalReplay = createHistoricalReplayStore(options.applicationDatabase);
  configureHistoricalReplayGate(historicalReplay);
  const scribeInbox = createScribeInbox(options.applicationDatabase, { recoverInterruptedAttempts: true });
  const restoreScribeInbox = configureScribeInbox(scribeInbox, async (draft) => {
    brainInbox.admitKnowledgeDelta(draft);
    await wakeBrain(brainInbox);
  });
  const inbox = createManagedChatInbox(archive, { allowed: admit });
  speakerActivity.recoverWith((dispatchId) => {
    const window = inbox.windowForDispatch(dispatchId);
    return window === undefined
      ? undefined
      : { windowId: window.id, chatId: window.chatId, messageCount: window.messages.length };
  });
  speakerActivity.recoverDirectivesWith((dispatchId) => deliveries.directiveForDispatch(dispatchId));
  let activeCanary: { readonly chatId: string; readonly text: string } | undefined;
  // The single source of truth for the managed-chat set, seeded from the static boot config and
  // advanced by every reload (#179). The post-auth boot path reads THIS, not the original
  // `options.managedChats` closure — so a reload that arrives while still pairing is not reverted
  // when authentication completes and applies the (then-stale) startup set.
  let currentManagedChats: readonly string[] = options.managedChats;
  const account = createWhatsAppAccount({
    storeDirectory: storeDir,
    archive: inbox.recorder,
    logger: upstreamWhatsAppLogger(),
    ...(options.sessionFactory === undefined ? {} : { sessionFactory: options.sessionFactory }),
  });
  const log = getLogger("whatsapp");
  // Liveness on the seam (#386), both halves of the #373 recommendation, wired before anything can
  // transition. Pull: `session.status` is read at observation time, so the reported transport can
  // never be a cached field that rotted. Push: one subscription for the life of the account, so a
  // transition *after* authentication reaches subscribers instead of vanishing.
  const liveness = whatsappObservation();
  liveness.refreshWith((published) => {
    let transport: TransportObservation | undefined;
    try {
      transport = transportObservation(account.transport?.());
    } catch (cause) {
      // The seam isolates a throwing projection by falling back to the *published* value — whose
      // liveness, for a booted runtime, is `online`. That fallback would be #312 again, with the
      // health claim now coming from the error path itself. A transport whose state cannot be read
      // is, to an operator, exactly a degraded transport, so say that instead.
      return whatsAppObservationOf(
        { ...published.status, error: `WhatsApp transport state is unreadable: ${errorMessage(cause)}` },
        { phase: "backing_off", reason: "transport_unreadable" },
      );
    }
    return whatsAppObservationOf(published.status, transport);
  });
  // Both halves are optional on the interface only because the test seams predate them. A real
  // account always has them, and an account without them would silently reinstate exactly the
  // pre-#386 regime — status written at boot and never updated again — so say so out loud.
  if (account.observeTransport === undefined || account.transport === undefined) {
    log.warn(
      { event: "whatsapp.transport-unobservable" },
      "This WhatsApp account exposes no live transport state; reported liveness is startup phase only",
    );
  }
  // Every reported-phase change is announced on the operator feed as well as on the channel, so the
  // outage is legible to someone reading logs (#382) and not only to something polling `/health`.
  // Only *changes* are logged: whatsappd emits a transition per retry attempt, and one line per
  // backoff tick would bury the transition that matters.
  let reportedPhase = liveness.snapshot().value.liveness.phase;
  const unsubscribeTransport =
    account.observeTransport?.(() => {
      // `snapshot()` runs the projection, which reads `session.status` — so this one call is where
      // the new transport state enters the channel and where `since` is stamped. Publishing the
      // result announces it to subscribers; it must not re-derive.
      const observed = liveness.snapshot().value;
      liveness.publish(observed);
      const current = observed.liveness;
      if (current.phase === reportedPhase) return;
      const event = OPERATOR_EVENT_FOR_PHASE[current.phase];
      // `reportedPhase` advances only when we actually narrate. Advancing it for a phase with no
      // operator event would defeat the dedupe: whatsappd's outage cycle is
      // `backing_off → connecting → backing_off`, so treating the middle as "reported" makes the
      // next tick look like a change and puts one `agent.degraded` line on the feed per retry —
      // the spam this guard exists to prevent, burying the transition that matters.
      if (event === undefined) return;
      reportedPhase = current.phase;
      log[current.phase === "online" ? "info" : "warn"](
        {
          operatorEvent: event,
          detail: `WhatsApp ${current.phase}${current.reason === undefined ? "" : `: ${current.reason}`}`,
          phase: current.phase,
          ...(current.reason === undefined ? {} : { reason: current.reason }),
          ...(current.retryAt === undefined ? {} : { retryAt: current.retryAt }),
          ...(current.terminal === undefined ? {} : { terminal: current.terminal }),
        },
        `WhatsApp transport is ${current.phase}`,
      );
    }) ?? (() => undefined);
  const unsubscribeDirectiveOutcomes = speakerActivity.subscribeDirectives({
    dispatched: () => undefined,
    settledWithoutSay: ({ directiveId }) => {
      try {
        deliveries.settleWithoutSay(directiveId, "Speaker completed without calling say_directive.");
      } catch (cause) {
        log.error({ directiveId, error: errorMessage(cause) }, "Failed to persist settled-without-Saying Outcome");
      }
    },
    settledFailed: ({ directiveId, error }) => {
      try {
        deliveries.failWithoutSay(directiveId, error);
      } catch (cause) {
        log.error({ directiveId, error: errorMessage(cause) }, "Failed to persist failed Directive Outcome");
      }
    },
  });
  setRuntimeStatus({ phase: "starting", chatTarget: gate.describe() });
  let stopping = false;

  const program = Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.sync(() => archive.close()));
    yield* Effect.addFinalizer(() => Effect.sync(() => surfaces.close()));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        // Stop the up-inbox port before the handle is finalized, so a webhook in flight during teardown
        // defers (503) rather than throwing on a closed SQLite handle and being lost.
        brainAlive = false;
        brainInbox.close();
      }),
    );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (proactiveClockTimer !== undefined) clearInterval(proactiveClockTimer);
      }),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => deliveries.close()));
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribeDirectiveOutcomes));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        unsubscribeTransport();
        // Drop the projection with the subscription. A stopped runtime has no transport, and a
        // channel that kept reading a dead account's getter would report the last thing it saw as
        // though it were live — the very shadowing this seam exists to prevent.
        liveness.refreshWith((published) => whatsAppObservationOf(published.status, undefined));
      }),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => historicalReplay.close()));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        restoreScribeInbox();
        scribeInbox.close();
      }),
    );
    yield* Effect.addFinalizer(() => Effect.promise(() => account.stop()));
    if (!gate.hasTarget) {
      yield* Effect.logWarning("No managed WhatsApp chat is configured; ingress remains fail-closed.");
    }
    const authenticatedAccount = yield* Effect.promise(() =>
      account.authenticate({
        onPairing: (pairing) => {
          setRuntimeStatus({ phase: "pairing", chatTarget: gate.describe(), pairing });
          // The terminal render that used to live here is deleted, not adapted (#386). This process
          // is the control plane: under a service manager its stdout is the journal, so a QR drawn
          // there was unreadable to the operator and a pairing code was a secret in a log file.
          // The material is retained on the setup channel, where a page that connects late — or is
          // reopened halfway through pairing — still finds it. `expiresAt` rides along as the
          // channel's renewal promise, so a QR the client stopped rotating reads stale rather than
          // looking like a live one nobody has scanned yet.
          publishPairingProgress(pairing);
        },
      }),
    );
    // One account var for both: `admit` consults active direct bindings for it, and a live reload activates
    // a new chat's Surface against it (#179).
    authenticatedJid = authenticatedAccount.jid;
    // Retire the pairing material the moment it stops being true, so a page that connects after
    // pairing completed sees "paired" rather than a QR that will never be scanned.
    publishPairingSettled({ jid: authenticatedAccount.jid });
    yield* Effect.sync(() => surfaces.activateConfigured(authenticatedAccount.jid, currentManagedChats));
    yield* Effect.sync(() =>
      configureIntentEscalationRuntime({
        inbox: brainInbox,
        surfaceIdForSpeaker: (speakerId) => surfaces.activeSurface(authenticatedAccount.jid, speakerId)?.id,
        wake: () => wakeBrain(brainInbox),
      }),
    );
    yield* Effect.sync(() =>
      configureBrainEffectsRuntime({
        inbox: brainInbox,
        wake: () => wakeBrain(brainInbox),
        // Resolved lazily at file time: composeSpeaker configures the issue-management runtime
        // process-global at app boot, well before any Batch files an issue.
        fileIssue: (request, effectId) => createIssueFiler(getIssueManagementRuntime())(request, effectId),
        // The full issue-mutation set (comment create/update/delete, issue update, state change) shares
        // the same lazily-resolved issue-management runtime and the same Operation-Identity crash-dedup.
        mutateIssue: (mutation, effectId) => createIssueMutator(getIssueManagementRuntime())(mutation, effectId),
        // Resolve a Brain-chosen target entity to its Surface during prompt admission (§8) — see
        // resolveEntitySurface. No graph wired (boot/tests) means nothing resolves: fail-closed.
        resolveSurfaceForEntity: (entityId) => {
          const graph = tryGetGraphStore();
          return graph === undefined
            ? undefined
            : resolveEntitySurface({ graph, surfaces, accountJid: authenticatedAccount.jid }, entityId);
        },
        deliverPrompt: (effect) => {
          const binding = surfaces.activeBinding(effect.directive.surfaceId);
          if (binding === undefined) {
            throw new Error(`Surface ${effect.directive.surfaceId} has no active provider binding.`);
          }
          return (options.dispatch ?? dispatchSpeaker)({
            id: binding.providerChatId,
            input: {
              type: "brain.directive",
              directive: {
                ...effect.directive,
                brief: { ...effect.directive.brief, evidenceIds: [...effect.directive.brief.evidenceIds] },
              },
            },
          });
        },
      }),
    );
    yield* Effect.sync(() =>
      configureDelegationRuntime({
        inbox: brainInbox,
        wake: () => wakeBrain(brainInbox),
        providerChatIdForSurface: (surfaceId) => surfaces.activeBinding(surfaceId)?.providerChatId,
      }),
    );
    if (account.initialArchiveReady !== undefined && options.sessionFactory === undefined) {
      yield* Effect.promise(() => account.initialArchiveReady!());
      for (const state of historicalReplay.states()) {
        if (!currentManagedChats.includes(state.chatId)) historicalReplay.disable(state.chatId);
      }
      for (const chatId of currentManagedChats) {
        const state = historicalReplay.get(chatId);
        if (state === undefined) historicalReplay.admit(chatId);
        else if (state.mode === "disabled") historicalReplay.retry(chatId);
      }
      historicalReplay.captureSnapshots();
      while (historicalReplay.nextBatch() === undefined && historicalReplay.advance() > 0) {
        // Empty Surface snapshots cross snapshot -> tail -> live without a Flue run.
      }
      if (historicalReplay.states().some(({ mode }) => mode === "catching_up")) {
        const { runId } = yield* Effect.promise(() => invoke(historicalReplayWorkflow, { input: {} }));
        historicalReplay.setRunId(runId);
      }
    }
    const session = account.session();
    const botIds = botIdsOf(session, options.botLid);
    setRuntimeStatus({
      phase: "online",
      accountJid: authenticatedAccount.jid,
      chatTarget: gate.describe(),
      botIds,
    });
    yield* Effect.sync(() =>
      log.info(
        {
          operatorEvent: "agent.online",
          detail: "managed chat connected",
          botIds,
          chatTarget: gate.describe(),
        },
        "Speaker WhatsApp online",
      ),
    );
    yield* runWhatsAppSession(session, {
      // The event source admits via the same composite predicate, so a known-Person DM is two-way.
      gate: { ...gate, allowed: admit },
      history: archive,
      inbox,
      botLid: options.botLid,
      ...(options.dispatch === undefined ? {} : { dispatch: options.dispatch }),
      ...(options.coalescer === undefined ? {} : { coalescer: options.coalescer }),
      afterParticipationReady: async () => {
        await recoverPendingPrompts();
        await recoverPendingIssueFilings();
        await recoverPendingIssueMutations();
        // Reconcile prior-process accepted work FIRST: those runs cannot still be executing, so an
        // active/missing record is a genuine interrupt. Only then re-invoke launches that were
        // pending (reserved but never Flue-admitted) at crash time — re-invoking them makes their
        // runs active in THIS process, and reconciling after would wrongly interrupt live work whose
        // real result the admit guard (bridge.ts) would then silently drop.
        await reconcileSpecialistWorkAtBoot({ inbox: brainInbox, wake: () => wakeBrain(brainInbox), getRun });
        await recoverPendingSpecialistLaunches([coderSpecialistSpec, reviewerSpecialistSpec]);
        // Everything the Brain's tools need is now configured. Open the GitHub up-inbox wake gate, then
        // sweep — this dispatches any event admitted during boot, and future admissions wake directly.
        brainReady = true;
        await wakeBrain(brainInbox);
        // Proactive clock cron floor (§6): run the due scan once at boot, then on a slow interval. Boot
        // reconciliation admits any wake that came due while down; each fires exactly once (durable ledger).
        await runProactiveClock();
        const intervalMs = options.proactiveClockIntervalMs ?? DEFAULT_PROACTIVE_CLOCK_INTERVAL_MS;
        if (intervalMs > 0) {
          proactiveClockTimer = setInterval(() => void runProactiveClock(), intervalMs);
          proactiveClockTimer.unref?.();
        }
        await options.afterParticipationReady?.();
      },
    });
  });

  const runtimeProgram = Effect.scoped(program).pipe(Effect.provide(effectLoggerLayer(log)));
  const fiber = Effect.runFork(
    options.clock === undefined ? runtimeProgram : runtimeProgram.pipe(Effect.provideService(Clock.Clock, options.clock)),
  );
  void Effect.runPromise(Fiber.await(fiber)).then((exit) => {
    if (Exit.isFailure(exit) && !stopping) {
      const defects = exit.cause.reasons.filter(Cause.isDieReason).map(({ defect }) => defect);
      const terminalTransport = defects.find(
        (defect): defect is WhatsAppEventSourceTerminalError => defect instanceof WhatsAppEventSourceTerminalError,
      );
      const terminalAccount = defects.find(
        (defect): defect is WhatsAppAccountError =>
          defect instanceof WhatsAppAccountError && (defect.code === "logged_out" || defect.code === "suspended"),
      );
      const terminalStatus = terminalTransport?.status ?? terminalAccount?.terminalStatus;
      // Real authentication terminal errors carry whatsappd's exact FaultReason. Keep the code
      // fallback only for older/injected account errors that predate that typed status payload.
      const terminalReason = terminalStatus?.reason ?? terminalAccount?.code;
      setRuntimeStatus({
        phase: "failed",
        chatTarget: gate.describe(),
        error: terminalReason ?? String(exit.cause),
        ...(terminalStatus === undefined ? {} : { terminal: terminalStatus }),
      });
      // Settle the setup channel too, when the failure landed mid-pairing. Leaving it on
      // `awaiting_scan` would make a setup page infer failure from a QR going stale, one channel
      // over, when the seam has a `failed` state that says it outright.
      publishPairingSettled({ reason: terminalReason ?? String(exit.cause) });
      // On the operator feed too, not only in the phase: the fiber dying is the other way the
      // coworker goes offline, and a Logs screen that narrates transport faults but stays silent
      // when the runtime itself fails would be telling half the story.
      // A terminal transport was already narrated by the process-lifetime status subscription.
      // Do not emit a second offline event when that same typed status ends the scoped fiber.
      if (terminalReason === undefined) {
        log.error(
          { operatorEvent: "agent.offline", detail: "the WhatsApp runtime failed", cause: String(exit.cause) },
          "WhatsApp runtime failed",
        );
      }
      const loggedOut = terminalStatus?.phase === "logged_out" || terminalAccount?.code === "logged_out";
      if (loggedOut) {
        // whatsappd clears its store on terminal logged_out; the session is unrecoverable
        // in-process. Exit cleanly (finalizers already ran) and point at the guided repair.
        process.stderr.write(
          `WhatsApp authentication ended in logged_out (${terminalReason ?? "reason unavailable"}) and the session store is no longer usable.\n` +
            "Run ambient-agent repair whatsapp to pair again; configuration, credentials, and history are preserved.\n",
        );
        (options.exit ?? process.exit)(1);
      }
    } else {
      setRuntimeStatus({ phase: "stopped", chatTarget: gate.describe() });
    }
  });
  return {
    reloadManagedChats: (chatIds) => {
      currentManagedChats = chatIds;
      gate.reload(chatIds);
      // Re-run the SAME boot operation against the new set (#179): activateConfigured retires every
      // active Surface not in the set and (re)activates the ones in it, preserving surface_ids for
      // chats that remain. So a newly-authorized chat gains a Surface it can escalate through, AND a
      // de-authorized chat's outbound Surface is retired — closing outbound Brain delivery in lockstep
      // with the gate closing inbound. A no-op until the account is authenticated.
      // A Brain-opened DM (S5, kind='direct') is deliberately preserved: activateConfigured retires only
      // 'configured' (or other-account) bindings, so a live reload never sweeps an active known-Person DM.
      if (authenticatedJid !== undefined) surfaces.activateConfigured(authenticatedJid, chatIds);
    },
    synchronizedChats: async () => await account.synchronizedChats(),
    smokeCanary: async (nonce, timeoutMillis) => {
      const chatId = options.canaryChat;
      if (chatId === undefined) {
        throw new WhatsAppSmokeCanaryError(409, "No dedicated smoke canary group is configured.");
      }
      if (!currentManagedChats.some((managed) => managed.toLowerCase() === chatId.toLowerCase())) {
        throw new WhatsAppSmokeCanaryError(400, "The configured smoke canary group is not a Managed Chat.");
      }
      if (activeCanary !== undefined) {
        throw new WhatsAppSmokeCanaryError(409, "A live smoke canary is already running.");
      }
      const text = `SMOKE ${nonce} — ignore`;
      activeCanary = { chatId, text };
      let dispatchId: string | undefined;
      let providerMessageId: string | undefined;
      const observedDispatches: SpeakerDispatchEvent[] = [];
      const observedTerminal = new Map<string, "silent" | Error>();
      let finishLifecycle: ((result: "silent" | Error) => void) | undefined;
      const correlateDispatch = (event: SpeakerDispatchEvent): void => {
        if (providerMessageId === undefined || dispatchId !== undefined) return;
        const window = inbox.window(event.windowId);
        if (window?.messages.some((message) => message.id === providerMessageId)) {
          dispatchId = event.dispatchId;
          const terminal = observedTerminal.get(event.dispatchId);
          if (terminal !== undefined) finishLifecycle?.(terminal);
        }
      };
      let unsubscribe: () => void = () => undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const lifecycle = new Promise<void>((resolve, reject) => {
          const finish = (result: "silent" | Error): void => {
            if (timer !== undefined) clearTimeout(timer);
            if (result === "silent") resolve();
            else reject(result);
          };
          finishLifecycle = finish;
          const terminal = (candidateDispatchId: string, result: "silent" | Error): void => {
            observedTerminal.set(candidateDispatchId, result);
            if (candidateDispatchId === dispatchId) finish(result);
          };
          unsubscribe = (options.observeActivity ?? speakerActivity.subscribe)({
            windowDispatched: (event) => {
              observedDispatches.push(event);
              correlateDispatch(event);
            },
            spoke: (event) => {
              terminal(
                event.dispatchId,
                new WhatsAppSmokeCanaryError(504, "The SMOKE canary spoke instead of settling silent."),
              );
            },
            settledSilent: (event) => {
              terminal(event.dispatchId, "silent");
            },
            settledFailed: (event) => {
              terminal(event.dispatchId, new WhatsAppSmokeCanaryError(504, "The SMOKE canary dispatch failed."));
            },
          });
          timer = setTimeout(
            () =>
              finish(
                new WhatsAppSmokeCanaryError(
                  504,
                  "The SMOKE canary timed out before admission, dispatch, and silent settlement.",
                ),
              ),
            timeoutMillis,
          );
        });
        void lifecycle.catch(() => undefined);
        if (account.sendSmokeCanary === undefined) {
          throw new WhatsAppSmokeCanaryError(503, "The WhatsApp account cannot send smoke canaries.");
        }
        providerMessageId = (await account.sendSmokeCanary(chatId, text)).messageId;
        for (const event of observedDispatches) correlateDispatch(event);
        await lifecycle;
        if (dispatchId === undefined) {
          throw new WhatsAppSmokeCanaryError(504, "The SMOKE canary settled without a correlated dispatch.");
        }
        return { chatId, text, stages: ["admission", "dispatch", "settled-silent"] };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        unsubscribe();
        activeCanary = undefined;
      }
    },
    stop: async () => {
      stopping = true;
      await Effect.runPromise(Fiber.interrupt(fiber));
      setRuntimeStatus({ phase: "stopped", chatTarget: gate.describe() });
    },
  };
};
