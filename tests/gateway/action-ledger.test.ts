import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { SessionState } from "eve/client";
import type { ToolContext } from "eve/tools";
import { afterEach, describe, expect, it } from "vitest";
import {
  emptyActionLedger,
  findLedgerItem,
  renderLedgerInstructions,
  todayCounts,
  type ActionLedger,
  type LedgerAccess,
} from "../../agent/lib/action-ledger.ts";
import { GatewayStore } from "../../agent/lib/jobs.ts";
import type { GithubResult } from "../../agent/subagents/github/lib/output-schema.ts";
import { executeLedgerDelegate, type DelegateDependencies } from "../../agent/tools/ledger_delegate.ts";
import { executeRecordJobResult, type RecordResultDependencies } from "../../agent/tools/record_job_result.ts";
import { forkPendingJobs, type JobLoopback } from "../../src/gateway/job-runner.ts";

const dirs: string[] = [];

const temporaryDatabase = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "wa-ledger-replay-"));
  dirs.push(dir);
  return join(dir, "gateway.sqlite");
};

const memoryLedger = (): LedgerAccess & { readonly value: ActionLedger } => {
  let current = emptyActionLedger();
  return {
    get value() {
      return current;
    },
    get: () => current,
    update(fn) {
      current = fn(current);
    },
  };
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("F1/F7 durable voice-ledger replay", () => {
  it("blocks a second delegation/create, targets the known #N for correction, and counts today", async () => {
    const path = temporaryDatabase();
    const store = new GatewayStore(path);
    store.set("team@g.us", { sessionId: "voice-ledger", streamIndex: 0 });
    const ledger = memoryLedger();
    const now = new Date("2026-07-13T12:00:00.000Z");
    const ctx = { session: { id: "voice-ledger" } } as ToolContext;
    const delegateDeps: DelegateDependencies = {
      ledger,
      openStore: () => new GatewayStore(path),
      newJobId: () => `job-${ledger.value.jobs.length + 1}`,
      now: () => now,
    };
    const recordDeps: RecordResultDependencies = {
      ledger,
      openStore: () => new GatewayStore(path),
      now: () => now,
    };
    let delegated = 0;
    let creates = 0;
    const results: GithubResult[] = [];
    const loopback: JobLoopback = {
      async runGithub(job) {
        delegated += 1;
        const update = job.task.includes("Ledger-constrained issue #77");
        const result: GithubResult = update
          ? { action: "label", number: 77, url: "https://github.com/acme/repo/issues/77", summary: "Marked #77 as a feature." }
          : { action: "create_issue", number: 77, url: "https://github.com/acme/repo/issues/77", summary: "Filed #77." };
        if (result.action === "create_issue") creates += 1;
        results.push(result);
        return result;
      },
      async deliverVoice(job, state) {
        executeRecordJobResult(job.id, "voice-ledger", recordDeps);
        return { ...state, streamIndex: state.streamIndex + 1 };
      },
    };

    const runPending = async (): Promise<number> =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const doneBefore = store.listJobs().filter((job) => job.status === "done").length;
            const reportPendingBefore = store.listJobs().filter((job) => job.status === "report_pending").length;
            const claimed = yield* forkPendingJobs(store, loopback, 10);
            yield* Effect.promise(() =>
              expect.poll(() => store.listJobs().filter((job) => job.status === "report_pending").length).toBe(reportPendingBefore + claimed),
            );
            expect(yield* forkPendingJobs(store, loopback, 10)).toBe(claimed);
            yield* Effect.promise(() =>
              expect.poll(() => store.listJobs().filter((job) => job.status === "done").length).toBe(doneBefore + claimed),
            );
            return claimed;
          }),
        ),
      );

    // F1: first report delegates and creates one real issue.
    expect(
      executeLedgerDelegate(
        {
          kind: "github",
          task: "The Profile page crashes to a blank white screen on an iPhone 5s after tapping Settings.",
        },
        ctx,
        delegateDeps,
      ),
    ).toMatchObject({ status: "started" });
    expect(await runPending()).toBe(1);
    expect(delegated).toBe(1);
    expect(creates).toBe(1);
    expect(ledger.value.items).toEqual([expect.objectContaining({ kind: "issue", number: 77, status: "open" })]);

    // An exact replay is acknowledged without handing the voice model a second
    // report URL to echo into the chat.
    const exactReplay = executeLedgerDelegate(
      {
        kind: "github",
        task: "The Profile page crashes to a blank white screen on an iPhone 5s after tapping Settings.",
      },
      ctx,
      delegateDeps,
    );
    expect(exactReplay).toMatchObject({ status: "already_handled", jobId: "job-1" });
    expect(exactReplay).not.toHaveProperty("summary");
    expect(exactReplay).not.toHaveProperty("number");
    expect(exactReplay).not.toHaveProperty("url");

    // F1 replay: a real paraphrase is a possible duplicate, never a certainty.
    // The tool returns the prior evidence and queues nothing while the voice clarifies.
    expect(
      executeLedgerDelegate(
        {
          kind: "github",
          task: "The Profile screen is white when I open preferences on my old Apple phone.",
        },
        ctx,
        delegateDeps,
      ),
    ).toMatchObject({
      status: "possible_duplicate",
      requiresConfirmation: true,
      number: 77,
      url: "https://github.com/acme/repo/issues/77",
    });
    expect(store.listJobs()).toHaveLength(1);
    expect(delegated).toBe(1);
    expect(creates).toBe(1);

    // F7: an explicit correction targets the ledger-known item. The queue
    // receives an update-constrained task, and the worker performs no create.
    expect(
      executeLedgerDelegate({ kind: "github", task: "Make #77 a feature request instead of a bug." }, ctx, delegateDeps),
    ).toMatchObject({ status: "started" });
    const correction = store.listJobs().find((job) => job.task.includes("Make #77"));
    expect(correction?.task).toMatch(/Ledger-constrained issue #77.*do not create a replacement/s);
    expect(await runPending()).toBe(1);
    expect(delegated).toBe(2);
    expect(creates).toBe(1);
    expect(results.map((result) => result.action)).toEqual(["create_issue", "label"]);

    expect(todayCounts(ledger.value, now)).toEqual({ jobs: 2, issues: 1, prs: 0 });
    expect(renderLedgerInstructions(ledger.value, now)).toContain(
      "Today (2026-07-13 UTC): 1 issue(s), 0 pull request(s), 2 job(s) touched.",
    );
  });

  it("does not silently discard a distinct report that resembles prior work", () => {
    const path = temporaryDatabase();
    const ledger = memoryLedger();
    const ctx = { session: { id: "voice-distinct" } } as ToolContext;
    const deps: DelegateDependencies = {
      ledger,
      openStore: () => new GatewayStore(path),
      newJobId: () => `job-${ledger.value.jobs.length + 1}`,
      now: () => new Date("2026-07-13T12:00:00Z"),
    };
    const prior = "The Profile page crashes to a blank white screen on an iPhone 5s after tapping Settings.";
    const distinct = "The Settings button in Profile is blank on iPhone 5s, but the page itself still works.";

    expect(executeLedgerDelegate({ kind: "github", task: prior }, ctx, deps)).toMatchObject({ status: "started" });
    expect(executeLedgerDelegate({ kind: "github", task: prior, confirmedDistinct: true }, ctx, deps)).toMatchObject({
      status: "already_handled",
      jobId: "job-1",
    });
    expect(executeLedgerDelegate({ kind: "github", task: distinct }, ctx, deps)).toMatchObject({
      status: "possible_duplicate",
      requiresConfirmation: true,
      jobId: "job-1",
    });
    let store = new GatewayStore(path);
    expect(store.listJobs()).toHaveLength(1);
    store.close();

    // Explicit user confirmation is the safe escape: now the distinct work is queued.
    expect(executeLedgerDelegate({ kind: "github", task: distinct, confirmedDistinct: true }, ctx, deps)).toMatchObject({
      status: "started",
      jobId: "job-2",
    });
    store = new GatewayStore(path);
    expect(store.listJobs()).toHaveLength(2);
    expect(store.getJob("job-2")?.task).toBe(distinct);
    store.close();
  });

  it("constrains a typed unknown #N and blocks an untyped unknown #N", () => {
    const path = temporaryDatabase();
    const ledger = memoryLedger();
    const ctx = { session: { id: "voice-target" } } as ToolContext;
    const deps: DelegateDependencies = {
      ledger,
      openStore: () => new GatewayStore(path),
      newJobId: () => "typed-target",
      now: () => new Date("2026-07-13T12:00:00Z"),
    };

    expect(executeLedgerDelegate({ kind: "github", task: "Comment on issue #404 with the workaround." }, ctx, deps)).toMatchObject({
      status: "started",
    });
    let store = new GatewayStore(path);
    expect(store.getJob("typed-target")?.task).toMatch(/Ledger-constrained issue #404/);
    store.close();

    const empty = memoryLedger();
    expect(
      executeLedgerDelegate(
        { kind: "github", task: "Update #405 with the workaround." },
        ctx,
        {
          ledger: empty,
          openStore: () => {
            throw new Error("ambiguous target must not open the queue");
          },
          newJobId: () => "must-not-exist",
          now: () => new Date("2026-07-13T12:00:00Z"),
        },
      ),
    ).toMatchObject({ status: "needs_clarification", number: 405, candidates: [] });
    store = new GatewayStore(path);
    expect(store.listJobs()).toHaveLength(1);
    store.close();
  });

  it("blocks a bare #N when issue and PR identities are ambiguous", () => {
    const ledger = memoryLedger();
    ledger.update(() => ({
      version: 1,
      jobs: [],
      items: [
        { kind: "issue", number: 77, status: "open", summary: "Issue", at: "2026-07-13", evidence: [] },
        { kind: "pull_request", number: 77, status: "open", summary: "PR", at: "2026-07-13", evidence: [] },
      ],
    }));
    expect(
      executeLedgerDelegate(
        { kind: "github", task: "Update #77." },
        { session: { id: "voice-ambiguous" } } as ToolContext,
        {
          ledger,
          openStore: () => {
            throw new Error("ambiguous target must not open the queue");
          },
          newJobId: () => "must-not-exist",
          now: () => new Date("2026-07-13T12:00:00Z"),
        },
      ),
    ).toMatchObject({ status: "needs_clarification", number: 77, candidates: ["issue", "pull_request"] });
  });

  it("constrains a bare #N from a unique ledger identity", () => {
    const path = temporaryDatabase();
    const ledger = memoryLedger();
    ledger.update(() => ({
      version: 1,
      jobs: [],
      items: [{ kind: "pull_request", number: 21, status: "open", summary: "PR", at: "2026-07-13", evidence: [] }],
    }));
    expect(
      executeLedgerDelegate(
        { kind: "github", task: "Update #21 with the review note." },
        { session: { id: "voice-unique" } } as ToolContext,
        {
          ledger,
          openStore: () => new GatewayStore(path),
          newJobId: () => "unique-target",
          now: () => new Date("2026-07-13T12:00:00Z"),
        },
      ),
    ).toMatchObject({ status: "started" });
    const store = new GatewayStore(path);
    expect(store.getJob("unique-target")?.task).toMatch(/Ledger-constrained pull_request #21/);
    store.close();
  });

  it("removes the pending queue row when the defineState write fails synchronously", () => {
    const path = temporaryDatabase();
    const store = new GatewayStore(path);
    let enqueues = 0;
    const ledger: LedgerAccess = {
      get: emptyActionLedger,
      update() {
        throw new Error("state unavailable");
      },
    };

    expect(() =>
      executeLedgerDelegate(
        { kind: "github", task: "File the settings crash." },
        { session: { id: "voice-failure" } } as ToolContext,
        {
          ledger,
          openStore: () => ({
            cancelPending: (id) => store.cancelPending(id),
            enqueue(input) {
              enqueues += 1;
              return store.enqueue(input);
            },
            close() {},
          }),
          newJobId: () => "job-compensated",
          now: () => new Date("2026-07-13T12:00:00Z"),
        },
      ),
    ).toThrow("state unavailable");
    expect(enqueues).toBe(1);
    expect(store.listJobs()).toHaveLength(0);
    store.close();
  });

  it("does not write a started ledger entry when durable enqueue fails", () => {
    const ledger = memoryLedger();
    expect(() =>
      executeLedgerDelegate(
        { kind: "github", task: "File the settings crash." },
        { session: { id: "voice-failure" } } as ToolContext,
        {
          ledger,
          openStore: () => ({
            cancelPending() {
              throw new Error("must not compensate a row that was never inserted");
            },
            enqueue() {
              throw new Error("sqlite unavailable");
            },
            close() {},
          }),
          newJobId: () => "job-rolled-back",
          now: () => new Date("2026-07-13T12:00:00Z"),
        },
      ),
    ).toThrow("sqlite unavailable");
    expect(ledger.value.jobs).toHaveLength(0);
  });

  it("scopes dedup to the current voice session ledger", () => {
    const path = temporaryDatabase();
    const first = memoryLedger();
    const second = memoryLedger();
    const deps = (ledger: LedgerAccess, id: string): DelegateDependencies => ({
      ledger,
      openStore: () => new GatewayStore(path),
      newJobId: () => id,
      now: () => new Date("2026-07-13T12:00:00Z"),
    });
    const task = "File the profile crash after opening Settings.";

    expect(
      executeLedgerDelegate({ kind: "github", task }, { session: { id: "voice-one" } } as ToolContext, deps(first, "one")),
    ).toMatchObject({ status: "started" });
    expect(
      executeLedgerDelegate({ kind: "github", task }, { session: { id: "voice-one" } } as ToolContext, deps(first, "unused")),
    ).toMatchObject({ status: "already_handled" });
    expect(
      executeLedgerDelegate({ kind: "github", task }, { session: { id: "voice-two" } } as ToolContext, deps(second, "two")),
    ).toMatchObject({ status: "started" });

    const store = new GatewayStore(path);
    const jobs = store.listJobs();
    expect(jobs).toHaveLength(2);
    expect(jobs.map((job) => job.voiceSessionId).sort()).toEqual(["voice-one", "voice-two"]);
    store.close();
  });

  it("refuses to record another voice session's trusted job result", () => {
    const path = temporaryDatabase();
    const store = new GatewayStore(path);
    const id = store.enqueue({ id: "foreign-job", voiceSessionId: "voice-one", kind: "github", task: "File it." });
    store.set("one@g.us", { sessionId: "voice-one", streamIndex: 0 });
    expect(store.claimPending(1)).toHaveLength(1);
    store.queueResult(id, {
      action: "create_issue",
      number: 91,
      url: "https://github.com/acme/repo/issues/91",
      summary: "Filed #91.",
    });
    store.close();
    const ledger = memoryLedger();

    expect(() =>
      executeRecordJobResult(id, "voice-two", {
        ledger,
        openStore: () => new GatewayStore(path),
        now: () => new Date("2026-07-13T12:00:00Z"),
      }),
    ).toThrow("does not belong to this voice session");
    expect(ledger.value).toEqual(emptyActionLedger());
  });

  it("replays one stable tool call idempotently across a lost state checkpoint", () => {
    const path = temporaryDatabase();
    const task = "File the settings crash.";
    const ctx = { session: { id: "voice-replay" } } as ToolContext;
    const run = (ledger: LedgerAccess) =>
      executeLedgerDelegate(
        { kind: "github", task },
        ctx,
        {
          ledger,
          openStore: () => new GatewayStore(path),
          newJobId: () => "stable-call-id",
          now: () => new Date("2026-07-13T12:00:00Z"),
        },
      );

    // Simulate a process death in the exact enqueue -> defineState window.
    const crashedStore = new GatewayStore(path);
    crashedStore.enqueue({ id: "stable-call-id", voiceSessionId: "voice-replay", kind: "github", task });
    crashedStore.close();

    // Durable tool replay uses the same call-derived id. Enqueue is a no-op,
    // then the missing state entry is filled.
    const replayedLedger = memoryLedger();
    expect(run(replayedLedger)).toMatchObject({ status: "started", jobId: "stable-call-id" });
    const store = new GatewayStore(path);
    expect(store.listJobs()).toHaveLength(1);
    expect(replayedLedger.value.jobs).toHaveLength(1);
    store.close();
  });

  it("treats kind + number as GitHub identity and leaves ambiguous bare #N unresolved", () => {
    const ledger: ActionLedger = {
      version: 1,
      jobs: [],
      items: [
        { kind: "issue", number: 77, status: "open", summary: "Issue", at: "2026-07-13", evidence: [] },
        { kind: "pull_request", number: 77, status: "open", summary: "PR", at: "2026-07-13", evidence: [] },
      ],
    };
    expect(findLedgerItem(ledger, 77)).toBeUndefined();
    expect(findLedgerItem(ledger, 77, "issue")?.summary).toBe("Issue");
    expect(findLedgerItem(ledger, 77, "pull_request")?.summary).toBe("PR");
  });
});
