import { defineDynamic, defineTool } from "eve/tools";
import type { ToolContext } from "eve/tools";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  actionLedger,
  findPriorJobMatch,
  findLedgerItem,
  recordStartedJob,
  referencedNumber,
  referencedKind,
  type LedgerAccess,
} from "../lib/action-ledger.ts";
import { GatewayStore } from "../lib/jobs.ts";

export interface DelegateDependencies {
  readonly ledger: LedgerAccess;
  readonly openStore: () => Pick<GatewayStore, "cancelPending" | "close" | "enqueue">;
  readonly newJobId: (ctx: ToolContext) => string;
  readonly now: () => Date;
}

const dependencies = (): DelegateDependencies => ({
  ledger: actionLedger,
  openStore: () => new GatewayStore(),
  // Eve preserves callId across durable tool replay. A stable queue id makes
  // the SQLite side effect idempotent if a process dies after enqueue but
  // before the workflow checkpoint commits the defineState update.
  newJobId: (ctx) => createHash("sha256").update(`${ctx.session.id}:${ctx.callId}`).digest("hex"),
  now: () => new Date(),
});

type TargetResolution =
  | { readonly type: "none" }
  | { readonly type: "target"; readonly kind: "issue" | "pull_request"; readonly number: number }
  | { readonly type: "needs_clarification"; readonly number: number; readonly candidates: readonly string[] };

const resolveTarget = (task: string, ledger: LedgerAccess): TargetResolution => {
  const number = referencedNumber(task);
  if (number === undefined) return { type: "none" };
  const statedKind = referencedKind(task);
  if (statedKind !== undefined) return { type: "target", kind: statedKind, number };
  const item = findLedgerItem(ledger.get(), number);
  if (item !== undefined) return { type: "target", kind: item.kind, number };
  const candidates = ledger.get().items.filter((candidate) => candidate.number === number).map((candidate) => candidate.kind);
  return { type: "needs_clarification", number, candidates };
};

const constrainTarget = (task: string, target: Extract<TargetResolution, { type: "target" }>): string => {
  return (
    `Ledger-constrained ${target.kind} #${target.number}. Act on that exact item; do not create a replacement. ` +
    `Prefer the smallest available update operation (get/comment/label/close as requested).\n\n${task}`
  );
};

export const executeLedgerDelegate = (
  input: { readonly kind: "github"; readonly task: string; readonly confirmedDistinct?: boolean },
  ctx: ToolContext,
  deps: DelegateDependencies = dependencies(),
) => {
  const target = resolveTarget(input.task, deps.ledger);
  if (target.type === "needs_clarification") {
    return {
      status: "needs_clarification" as const,
      number: target.number,
      candidates: target.candidates,
      summary: `Clarify whether #${target.number} is an issue or pull request before delegating.`,
    };
  }

  const prior = findPriorJobMatch(deps.ledger.get(), input.task);
  if (prior?.confidence === "exact") {
    const duplicate = prior.job;
    return {
      status: "already_handled" as const,
      jobId: duplicate.id,
    };
  }
  if (input.confirmedDistinct !== true && prior?.confidence === "possible") {
    return {
      status: "possible_duplicate" as const,
      requiresConfirmation: true as const,
      jobId: prior.job.id,
      ...(prior.job.number === undefined ? {} : { number: prior.job.number }),
      ...(prior.job.url === undefined ? {} : { url: prior.job.url }),
      summary: prior.job.summary,
    };
  }

  const store = deps.openStore();
  const jobId = deps.newJobId(ctx);
  try {
    const task = target.type === "target" ? constrainTarget(input.task, target) : input.task;
    // Queue first. If the process dies immediately afterward, durable tool
    // replay uses the same call-derived id, enqueue is an idempotent no-op, and
    // the missing defineState entry is filled below. The reverse ordering can
    // strand a phantom "started" entry that suppresses the replay forever.
    store.enqueue({ id: jobId, voiceSessionId: ctx.session.id, kind: input.kind, task });
    try {
      deps.ledger.update((ledger) => recordStartedJob(ledger, { id: jobId, task: input.task, at: deps.now().toISOString() }));
    } catch (cause) {
      // A synchronous state failure occurs in the same tool tick, before the
      // runner can claim this row. Delete only pending work; never delete a job
      // that another actor has already started.
      store.cancelPending(jobId);
      throw cause;
    }
    return { jobId, status: "started" as const };
  } finally {
    store.close();
  }
};

/**
 * Additional dynamic capability: Eve explicitly allows a dynamic tool to
 * override a same-named authored tool. The frozen #8 delegate remains intact.
 */
export default defineDynamic({
  events: {
    "turn.started": () => ({
      delegate: defineTool({
        description:
          "Start a non-blocking GitHub task unless this voice session's durable ledger shows exact or possibly matching work. " +
          "Possible duplicates and ambiguous #numbers enqueue nothing and require clarification. A resolved #number is constrained exactly.",
        inputSchema: z.object({
          kind: z.literal("github"),
          task: z.string().min(1).describe("Everything the GitHub worker needs; it cannot see this chat."),
          confirmedDistinct: z
            .boolean()
            .optional()
            .describe("Set true only after the user explicitly confirms a possible duplicate is genuinely separate work."),
        }),
        execute({ kind, task, confirmedDistinct }, ctx) {
          return executeLedgerDelegate(
            { kind, task, ...(confirmedDistinct === undefined ? {} : { confirmedDistinct }) },
            ctx,
          );
        },
      }),
    }),
  },
});
