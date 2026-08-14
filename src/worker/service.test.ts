import { expect, test } from "vite-plus/test";
import type { GhCommand } from "../github/issues";
import type { AgentDefinition } from "../home/agents";
import type { WorkerAgent, WorkerAssignment, WorkerReceipt, WorkerWorkStore } from "./contract";
import { createWorkerService, type WorkerRunRecorder } from "./service";
import { createWorkerToolbox } from "./tools";

const model = {
  provider: "test",
  model: "deterministic",
  thinking: "off" as const,
  maxOutputTokens: 1024,
};

const definition: AgentDefinition = {
  name: "github-issues",
  description: "Files well-written GitHub issues.",
  model: "worker",
  instructions: "One issue per distinct problem.",
  tools: { github_issues: { repositories: ["owner/sandbox"] } },
  contentHash: "0123456789abcdef",
};

const assignment: WorkerAssignment = {
  id: "task-1",
  conversationId: "chat-1",
  objective: "File the crash reported by the group",
  workerProfile: "github-issues",
};

function fakeStore(claims: readonly WorkerAssignment[]) {
  const queue = [...claims];
  const artifacts: (WorkerReceipt & { taskId: string })[] = [];
  const attempts = new Map<string, number>();
  const transitions: { id: string; to: string; summary?: string }[] = [];
  const store: WorkerWorkStore = {
    claimNext: () => Promise.resolve(queue.shift()),
    transition(id, update) {
      transitions.push({
        id,
        to: update.to,
        ...("resultSummary" in update && update.resultSummary !== undefined
          ? { summary: update.resultSummary }
          : {}),
      });
      if (update.to === "queued") {
        const original = claims.find((claim) => claim.id === id);
        if (original) queue.push(original);
      }
      return Promise.resolve(undefined);
    },
    recordArtifact(input) {
      artifacts.push({
        taskId: input.taskId,
        kind: input.kind,
        title: input.title,
        value: input.value,
      });
      return Promise.resolve(undefined);
    },
    listArtifacts: (taskId) =>
      Promise.resolve(artifacts.filter((artifact) => artifact.taskId === taskId)),
    recordAttempt({ taskId }) {
      const attempt = (attempts.get(taskId) ?? 0) + 1;
      attempts.set(taskId, attempt);
      return Promise.resolve({ attempt });
    },
  };
  return { store, queue, artifacts, transitions };
}

function fakeRuns() {
  const finished: { id: string; status: string }[] = [];
  let counter = 0;
  const runs: WorkerRunRecorder = {
    start: () => Promise.resolve({ id: `run-${++counter}` }),
    finish(id, result) {
      finished.push({ id, status: result.status });
      return Promise.resolve();
    },
  };
  return { runs, finished };
}

/** Runs like the real Pi worker: calls the one bound tool, reports the outcome. */
function toolCallingAgent(): WorkerAgent {
  return {
    model,
    promptVersion: "worker-v1",
    async run(_input, tools) {
      const fileIssue = tools.find((tool) => tool.name === "file_issue");
      if (!fileIssue) throw new Error("file_issue tool missing");
      const result = await fileIssue.execute("call-1", {
        title: "Crash on save",
        body: "Steps: ...",
      });
      const text = result.content[0];
      return { summary: text?.type === "text" ? text.text : "filed" };
    },
  };
}

function service(options: {
  store: WorkerWorkStore;
  runs: WorkerRunRecorder;
  agent: WorkerAgent;
  gh?: GhCommand;
  compose?: () => ReturnType<ReturnType<typeof createWorkerToolbox>["compose"]>;
  maximumAttempts?: number;
  returned?: string[];
  narrated?: string[];
}) {
  const toolbox = createWorkerToolbox(options.gh ? { gh: options.gh } : {});
  return createWorkerService({
    work: options.store,
    runs: options.runs,
    agent: options.agent,
    compose: options.compose ?? (() => toolbox.compose(definition)),
    returnResult: (conversationId, taskId) => {
      options.returned?.push(`${conversationId}:${taskId}`);
      return Promise.resolve();
    },
    ...(options.maximumAttempts === undefined ? {} : { maximumAttempts: options.maximumAttempts }),
    narrate: (_conversation, profile, outcome) => {
      options.narrated?.push(`${profile}:${outcome}`);
    },
  });
}

test("the whole chain: claim, run, file, receipt, return, succeed", async () => {
  const { store, artifacts, transitions } = fakeStore([assignment]);
  const { runs, finished } = fakeRuns();
  const returned: string[] = [];
  const narrated: string[] = [];
  const gh: GhCommand = (args) =>
    Promise.resolve(args.includes("api") ? "[]" : "https://github.com/owner/sandbox/issues/9\n");

  const worker = service({ store, runs, agent: toolCallingAgent(), gh, returned, narrated });
  const outcome = await worker.runOnce("2026-08-14T10:00:00.000Z");

  expect(outcome.outcome).toBe("done");
  // The receipt was retained at the tool boundary, before completion.
  expect(artifacts).toEqual([
    {
      taskId: "task-1",
      kind: "url",
      title: "issue",
      value: "https://github.com/owner/sandbox/issues/9",
    },
  ]);
  expect(returned).toEqual(["chat-1:task-1"]);
  expect(transitions).toEqual([
    {
      id: "task-1",
      to: "succeeded",
      summary: "Filed issue #9: https://github.com/owner/sandbox/issues/9",
    },
  ]);
  expect(finished).toEqual([{ id: "run-1", status: "succeeded" }]);
  expect(narrated).toEqual(["github-issues:succeeded"]);
});

test("receipt-first recovery: an existing receipt completes without any model run", async () => {
  const { store, artifacts, transitions } = fakeStore([assignment]);
  artifacts.push({
    taskId: "task-1",
    kind: "url",
    title: "issue",
    value: "https://github.com/owner/sandbox/issues/4",
  });
  const { runs, finished } = fakeRuns();
  const returned: string[] = [];
  const agent: WorkerAgent = {
    model,
    run: () => Promise.reject(new Error("the model must not run when the receipt exists")),
  };

  const outcome = await service({ store, runs, agent, returned }).runOnce();

  expect(outcome.outcome).toBe("done");
  expect(returned).toEqual(["chat-1:task-1"]);
  expect(transitions[0]?.to).toBe("succeeded");
  expect(transitions[0]?.summary).toContain("issues/4");
  expect(finished).toEqual([]);
});

test("a composition problem parks immediately and loudly — no attempts burned", async () => {
  const { store, transitions } = fakeStore([assignment]);
  const { runs, finished } = fakeRuns();
  const returned: string[] = [];
  const narrated: string[] = [];
  const agent: WorkerAgent = {
    model,
    run: () => Promise.reject(new Error("must not run")),
  };

  const outcome = await service({
    store,
    runs,
    agent,
    compose: () => ({ problem: "agent not granted to this chat" }),
    returned,
    narrated,
  }).runOnce();

  expect(outcome.outcome).toBe("failed");
  expect(returned).toEqual(["chat-1:task-1"]);
  expect(transitions).toEqual([
    {
      id: "task-1",
      to: "failed",
      summary: 'Cannot run "github-issues": agent not granted to this chat',
    },
  ]);
  expect(finished).toEqual([]);
  expect(narrated).toEqual(["github-issues:parked"]);
});

test("failures retry to the attempt cap, then park with the return delivered", async () => {
  const { store, transitions } = fakeStore([assignment]);
  const { runs, finished } = fakeRuns();
  const returned: string[] = [];
  const narrated: string[] = [];
  const agent: WorkerAgent = {
    model,
    run: () => Promise.reject(new Error("provider blew up")),
  };

  const worker = service({ store, runs, agent, maximumAttempts: 2, returned, narrated });
  expect((await worker.runOnce()).outcome).toBe("failed");
  expect(narrated).toEqual(["github-issues:retrying"]);
  expect(returned).toEqual([]);

  expect((await worker.runOnce()).outcome).toBe("failed");
  expect(narrated).toEqual(["github-issues:retrying", "github-issues:parked"]);
  expect(returned).toEqual(["chat-1:task-1"]);
  expect(transitions.map(({ to }) => to)).toEqual(["failed", "queued", "failed"]);
  expect(transitions[2]?.summary).toContain("Parked after 2 failed attempts");
  expect(finished.map(({ status }) => status)).toEqual(["failed", "failed"]);
});

test("an empty queue is idle", async () => {
  const { store } = fakeStore([]);
  const { runs } = fakeRuns();
  const agent: WorkerAgent = { model, run: () => Promise.reject(new Error("no")) };
  expect((await service({ store, runs, agent }).runOnce()).outcome).toBe("idle");
});
