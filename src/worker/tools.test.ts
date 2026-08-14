import { expect, test } from "vite-plus/test";
import type { GhCommand } from "../github/issues";
import type { AgentDefinition } from "../home/agents";
import { createWorkerToolbox } from "./tools";

const definition: AgentDefinition = {
  name: "github-issues",
  description: "Files well-written GitHub issues.",
  model: "worker",
  instructions: "One issue per distinct problem.",
  tools: { github_issues: { repositories: ["owner/sandbox", "owner/product"] } },
  contentHash: "0123456789abcdef",
};

function fakeGh(responses: readonly string[]): GhCommand & { calls: string[][] } {
  const calls: string[][] = [];
  let index = 0;
  const command = (args: readonly string[]) => {
    calls.push([...args]);
    return Promise.resolve(responses[index++] ?? "");
  };
  return Object.assign(command, { calls });
}

test("check judges fragments: unknown tool, invalid shape, valid shape", () => {
  const toolbox = createWorkerToolbox();
  expect(toolbox.check("jira", {})).toBe("unknown tool");
  expect(toolbox.check("github_issues", { repositories: [] })).toBeDefined();
  expect(toolbox.check("github_issues", { repositories: ["owner/sandbox"] })).toBeUndefined();
});

test("composing without a grant keeps the ceiling; the summary derives from code", () => {
  const composed = createWorkerToolbox().compose(definition);
  if ("problem" in composed) throw new Error(composed.problem);
  expect(composed.targets).toEqual(["owner/sandbox", "owner/product"]);
  expect(composed.summary).toBe(
    "Files well-written GitHub issues.\nfiles GitHub issues into: owner/sandbox, owner/product",
  );
});

test("a grant narrows the ceiling and can never widen it", () => {
  const toolbox = createWorkerToolbox();
  const narrowed = toolbox.compose(definition, {
    tools: { github_issues: { repositories: ["owner/sandbox"] } },
  });
  if ("problem" in narrowed) throw new Error(narrowed.problem);
  expect(narrowed.targets).toEqual(["owner/sandbox"]);

  const widened = toolbox.compose(definition, {
    tools: { github_issues: { repositories: ["owner/sandbox", "owner/other"] } },
  });
  expect(widened).toEqual({
    problem: "github_issues: grant allows owner/other which the definition does not",
  });
});

test("a grant naming a tool the agent does not compose is loud", () => {
  const composed = createWorkerToolbox().compose(definition, {
    tools: { jira: {} },
  });
  expect(composed).toEqual({ problem: "jira: granted but not composed by this agent" });
});

test("binding pins the repository host-side; the model's tool has no repo axis", async () => {
  const gh = fakeGh(["[]", "https://github.com/owner/product/issues/12\n"]);
  const composed = createWorkerToolbox({ gh }).compose(definition);
  if ("problem" in composed) throw new Error(composed.problem);
  const [tool] = composed.bind({ taskId: "task-7", target: "owner/product" });
  expect(tool?.name).toBe("file_issue");
  expect(JSON.stringify(tool?.parameters)).not.toContain("repo");

  const result = await tool!.execute("call-1", { title: "Crash on save", body: "Steps: ..." });
  expect(result.details).toMatchObject({ number: 12, outcome: "filed" });
  const create = gh.calls[1]!;
  expect(create[create.indexOf("--repo") + 1]).toBe("owner/product");
  // The assignment id is the idempotency key stamped into the effect.
  expect(create[create.indexOf("--body") + 1]).toContain("Ambient-Task: task-7");
});

test("an out-of-constraint target throws at bind, never at the model", () => {
  const composed = createWorkerToolbox().compose(definition, {
    tools: { github_issues: { repositories: ["owner/sandbox"] } },
  });
  if ("problem" in composed) throw new Error(composed.problem);
  expect(() => composed.bind({ taskId: "task-8", target: "owner/product" })).toThrow(
    "outside this agent's allowed repositories",
  );
  expect(() => composed.bind({ taskId: "task-8", target: "owner/sandbox" })).not.toThrow();
});

test("a lone allowed repository is the default target; several demand an explicit one", () => {
  const toolbox = createWorkerToolbox({ gh: fakeGh([]) });
  const several = toolbox.compose(definition);
  if ("problem" in several) throw new Error(several.problem);
  expect(() => several.bind({ taskId: "task-9" })).toThrow("must name its target repository");

  const lone = toolbox.compose(definition, {
    tools: { github_issues: { repositories: ["owner/sandbox"] } },
  });
  if ("problem" in lone) throw new Error(lone.problem);
  expect(() => lone.bind({ taskId: "task-9" })).not.toThrow();
});

test("file_issue is single-use: one bounded effect per assignment", async () => {
  const gh = fakeGh(["[]", "https://github.com/owner/sandbox/issues/3\n"]);
  const composed = createWorkerToolbox({ gh }).compose(definition);
  if ("problem" in composed) throw new Error(composed.problem);
  const [tool] = composed.bind({ taskId: "task-10", target: "owner/sandbox" });
  await tool!.execute("call-1", { title: "t", body: "b" });
  await expect(tool!.execute("call-2", { title: "t", body: "b" })).rejects.toThrow(
    "once per assignment",
  );
});
