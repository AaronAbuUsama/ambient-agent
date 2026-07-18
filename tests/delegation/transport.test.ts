import { describe, expect, it } from "vite-plus/test";
import type { RunRecord } from "@flue/runtime";
import { configureFlueRuntime, InMemoryRunStore } from "@flue/runtime/internal";

import { createRunLedger } from "../../packages/agents/src/capabilities/delegation/ledger.ts";
import {
  deliverAfterExecution,
  deliverTerminalResult,
  installDelegationBridge,
  sweepUnsettledLaunches,
} from "../../packages/agents/src/capabilities/delegation/bridge.ts";
import { configureDelegationRuntime } from "../../packages/agents/src/capabilities/delegation/runtime.ts";
import type { SpecialistInput } from "../../packages/engine/src/inputs.ts";

const CHAT = "home@g.us";

const run = (over: Partial<RunRecord> & Pick<RunRecord, "runId" | "status">): RunRecord => ({
  workflowName: "coder",
  startedAt: "2026-07-18T00:00:00.000Z",
  ...over,
});

const harness = () => {
  const ledger = createRunLedger(":memory:");
  const runs = new Map<string, RunRecord>();
  const dispatched: { id: string; input: SpecialistInput }[] = [];
  const deps = {
    ledger,
    getRun: async (runId: string) => runs.get(runId) ?? null,
    dispatch: async (request: { id: string; input: SpecialistInput }) => {
      dispatched.push(request);
      return undefined;
    },
  };
  return { ledger, runs, dispatched, deps };
};

describe("run ledger", () => {
  it("records launches, lists a chat's newest-first, and settles once", () => {
    const ledger = createRunLedger(":memory:");
    ledger.record({ runId: "r1", chatId: CHAT, workflow: "coder", launchedAt: "2026-07-18T00:00:01.000Z" });
    ledger.record({ runId: "r2", chatId: CHAT, workflow: "coder", launchedAt: "2026-07-18T00:00:02.000Z" });
    ledger.record({ runId: "r3", workflow: "coder", launchedAt: "2026-07-18T00:00:03.000Z" }); // no-route

    expect(ledger.forChat(CHAT).map((r) => r.runId)).toEqual(["r2", "r1"]);
    expect(ledger.unsettled().map((r) => r.runId)).toEqual(["r1", "r2", "r3"]);
    expect(ledger.get("r3")?.chatId).toBeUndefined();

    ledger.settle("r1", "2026-07-18T00:00:09.000Z");
    expect(ledger.get("r1")?.settledAt).toBe("2026-07-18T00:00:09.000Z");
    ledger.settle("r1", "2026-07-18T00:00:10.000Z"); // no-op once settled
    expect(ledger.get("r1")?.settledAt).toBe("2026-07-18T00:00:09.000Z");
    expect(ledger.unsettled().map((r) => r.runId)).toEqual(["r2", "r3"]);
  });
});

describe("deliverTerminalResult — the ADR 0001 durable gate", () => {
  it("does NOT deliver while the run is still active (a mid-run crash never says 'completed')", async () => {
    const { ledger, runs, dispatched, deps } = harness();
    ledger.record({ runId: "r1", chatId: CHAT, workflow: "coder", launchedAt: "t0" });
    runs.set("r1", run({ runId: "r1", status: "active" }));

    await deliverTerminalResult("r1", deps);

    expect(dispatched).toEqual([]);
    expect(ledger.get("r1")?.settledAt).toBeUndefined(); // stays unsettled → boot sweep can still catch it
  });

  it("delivers status 'ok' with the nested result and the launch digest once Durably Terminal", async () => {
    const { ledger, runs, dispatched, deps } = harness();
    const graphContext = { seededFrom: [CHAT] };
    ledger.record({ runId: "r1", chatId: CHAT, workflow: "coder", launchedAt: "t0" });
    runs.set(
      "r1",
      run({
        runId: "r1",
        status: "completed",
        input: { chatId: CHAT, graphContext },
        result: { outcome: "opened-pr", prUrl: "https://x/pr/1" },
      }),
    );

    await deliverTerminalResult("r1", deps);

    expect(dispatched).toEqual([
      {
        id: CHAT,
        input: {
          type: "specialist.result",
          chatId: CHAT,
          runId: "r1",
          status: "ok",
          result: { outcome: "opened-pr", prUrl: "https://x/pr/1" },
          graphContext,
        },
      },
    ]);
    expect(ledger.get("r1")?.settledAt).toBeDefined();
  });

  it("settles a no-route terminal run without dispatching (its work rests in the record)", async () => {
    const { ledger, runs, dispatched, deps } = harness();
    ledger.record({ runId: "r1", workflow: "coder", launchedAt: "t0" });
    runs.set("r1", run({ runId: "r1", status: "completed", result: { outcome: "opened-pr" } }));

    await deliverTerminalResult("r1", deps);

    expect(dispatched).toEqual([]);
    expect(ledger.get("r1")?.settledAt).toBeDefined();
  });

  it("is a no-op for an already-settled launch and for a runId it never launched", async () => {
    const { ledger, runs, dispatched, deps } = harness();
    ledger.record({ runId: "r1", chatId: CHAT, workflow: "coder", launchedAt: "t0" });
    ledger.settle("r1", "t9");
    runs.set("r1", run({ runId: "r1", status: "completed", result: {} }));

    await deliverTerminalResult("r1", deps); // already settled
    await deliverTerminalResult("unknown", deps); // never in the ledger

    expect(dispatched).toEqual([]);
  });
});

describe("the installed instrument() interceptor — the whole seam", () => {
  // Drives the real bridge function `installDelegationBridge()` registers, over a real
  // ambient run store (so the bridge's own `getRun` reads it). `next()` stands in for a
  // workflow run: it persists the terminal record the way flue's lifecycle does, then
  // resolves (complete) or rethrows (crash). A placeholder Specialist would take this exact
  // path; no live model is needed to prove the return seam.
  const seam = () => {
    const runStore = new InMemoryRunStore();
    // ponytail: only `target`/`runStore` are read by ambient getRun — the rest of the
    // FlueRuntime shape is irrelevant here, so cast past it rather than build a fake app.
    configureFlueRuntime({ target: "node", runStore } as never);
    const ledger = createRunLedger(":memory:");
    const dispatched: { id: string; input: SpecialistInput }[] = [];
    configureDelegationRuntime({
      ledger,
      dispatch: async (request) => {
        dispatched.push(request);
        return undefined;
      },
    });
    installDelegationBridge();
    return { runStore, ledger, dispatched };
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0)); // delivery is detached (void)
  const op = (runId: string) =>
    ({ type: "workflow", runId, workflowName: "coder", phase: "start", startedAt: "t0" }) as const;

  it("delivers status 'ok' with the result when the run completes", async () => {
    const { runStore, ledger, dispatched } = seam();
    ledger.record({ runId: "done", chatId: CHAT, workflow: "coder", launchedAt: "t0" });
    await runStore.createRun({ runId: "done", workflowName: "coder", startedAt: "t0", input: undefined });

    await deliverAfterExecution(op("done"), async () => {
      await runStore.endRun({ runId: "done", endedAt: "t1", isError: false, durationMs: 1, result: { outcome: "opened-pr" } });
      return { outcome: "opened-pr" };
    });
    await flush();

    expect(dispatched).toEqual([
      {
        id: CHAT,
        input: { type: "specialist.result", chatId: CHAT, runId: "done", status: "ok", result: { outcome: "opened-pr" } },
      },
    ]);
  });

  it("still delivers (as 'interrupted', no payload) when the run throws — the crash never goes silent", async () => {
    const { runStore, ledger, dispatched } = seam();
    ledger.record({ runId: "boom", chatId: CHAT, workflow: "coder", launchedAt: "t0" });
    await runStore.createRun({ runId: "boom", workflowName: "coder", startedAt: "t0", input: undefined });
    const boom = new Error("crashed mid-run");

    await expect(
      deliverAfterExecution(op("boom"), async () => {
        // flue's withWorkflowRunLifecycle persists run_end (errored) then RETHROWS.
        await runStore.endRun({ runId: "boom", endedAt: "t1", isError: true, durationMs: 1, error: { message: "crashed" } });
        throw boom;
      }),
    ).rejects.toBe(boom); // the interceptor must not swallow the error
    await flush();

    expect(dispatched).toEqual([
      { id: CHAT, input: { type: "specialist.result", chatId: CHAT, runId: "boom", status: "interrupted" } },
    ]);
  });
});

describe("sweepUnsettledLaunches — boot reconciliation", () => {
  it("turns every unsettled launch into an interrupted result and settles it", async () => {
    const { ledger, dispatched, deps } = harness();
    ledger.record({ runId: "r1", chatId: CHAT, workflow: "coder", launchedAt: "t0" });
    ledger.record({ runId: "r2", workflow: "coder", launchedAt: "t1" }); // no-route
    ledger.record({ runId: "r3", chatId: CHAT, workflow: "coder", launchedAt: "t2" });
    ledger.settle("r3", "t3"); // already delivered before the crash

    await sweepUnsettledLaunches(deps, () => "swept");

    expect(dispatched).toEqual([
      { id: CHAT, input: { type: "specialist.result", chatId: CHAT, runId: "r1", status: "interrupted" } },
    ]);
    expect(ledger.get("r1")?.settledAt).toBe("swept");
    expect(ledger.get("r2")?.settledAt).toBe("swept"); // no-route: settled, not dispatched
    expect(ledger.get("r3")?.settledAt).toBe("t3"); // untouched
    expect(ledger.unsettled()).toEqual([]);
  });
});
