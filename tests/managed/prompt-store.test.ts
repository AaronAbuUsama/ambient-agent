import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  configurePromptStore,
  createMemoryPromptRows,
  createPromptStore,
  promptVersion,
  type ShippedPrompt,
} from "../../packages/engine/src/prompts/store.ts";
import { createManagedConfigStore } from "../../packages/installation/src/managed-config-store.ts";
import { PROMPT_IDS, SHIPPED_PROMPTS, promptStore } from "../../packages/agents/src/prompts/catalog.ts";
import { speakerRuntimeConfig } from "../../packages/agents/src/speaker/agent.ts";
import { brainRuntimeConfig } from "../../packages/agents/src/brain/agent.ts";
import { scribeAttemptRuntimeConfig } from "../../packages/agents/src/scribe/agent.ts";
import { withScribeAttemptContext } from "../../packages/agents/src/scribe/attempt-context.ts";
import { coderRuntimeConfig, roleProfiles } from "../../packages/agents/src/capabilities/coder/workflow.ts";
import { configureCoderRuntime } from "../../packages/agents/src/capabilities/coder/runtime.ts";
import { reviewerRuntimeConfig } from "../../packages/agents/src/capabilities/reviewer/workflow.ts";
import { configureReviewerRuntime } from "../../packages/agents/src/capabilities/reviewer/runtime.ts";
import { runCli } from "../../apps/cli/src/program.ts";

const SKILL_BODY = ["---", "name: demo-skill", "description: A demo skill body.", "---", "", "# Demo", "", "Do the thing."].join("\n");

const shipped = (body: string, skillBody = SKILL_BODY): readonly ShippedPrompt[] => [
  { id: "instructions:demo", kind: "instructions", body },
  { id: "skill:demo", kind: "skill", body: skillBody },
];

const freshStore = () => createPromptStore(createMemoryPromptRows());

/** Every module that can define an agent's runtime config: agent modules and capability workflows. */
const agentModules = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return await agentModules(path);
      return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
    }),
  );
  return nested.flat();
};

describe("the prompt store", () => {
  it("seeds every shipped entry on first boot and records the version it was seeded from", () => {
    const store = freshStore();
    store.seed(shipped("first"));

    const entry = store.entry("instructions:demo");
    expect(entry.body).toBe("first");
    expect(entry.customised).toBe(false);
    expect(entry.seededVersion).toBe(promptVersion("first"));
    expect(entry.shippedVersion).toBe(promptVersion("first"));
    expect(store.resolve("skill:demo")).toBe(SKILL_BODY);
    // Seeding twice is a no-op, not a churn of updatedAt-only writes — asserted on updatedAt,
    // because asserting only on the body passes even when every boot rewrites every row.
    store.seed(shipped("first"));
    expect(store.entry("instructions:demo")).toEqual(entry);
  });

  it("re-seeds rather than mislabelling an entry whose shipped kind changed", () => {
    const store = freshStore();
    store.seed(shipped("first"));
    store.save("skill:demo", SKILL_BODY.replace("Do the thing.", "Do the operator's thing."));

    // The id now ships as instructions. Keeping the customised skill document would leave a body
    // labelled `instructions` that no longer means anything — and the reverse case would leave a
    // plain string labelled `skill`, which only fails at the next agent turn.
    store.seed([{ id: "skill:demo", kind: "instructions", body: "now an instruction block" }]);
    const entry = store.entry("skill:demo");
    expect(entry.kind).toBe("instructions");
    expect(entry.body).toBe("now an instruction block");
    expect(entry.customised).toBe(false);
    expect(store.resolve("skill:demo")).toBe("now an instruction block");
  });

  it("re-seeds an untouched entry when the shipped version changes", () => {
    const store = freshStore();
    store.seed(shipped("first"));
    store.seed(shipped("second"));

    const entry = store.entry("instructions:demo");
    expect(entry.body).toBe("second");
    expect(entry.customised).toBe(false);
    expect(entry.seededVersion).toBe(promptVersion("second"));
  });

  it("preserves an edited entry across the upgrade, marks it customised, and keeps the divergence visible", () => {
    const store = freshStore();
    store.seed(shipped("first"));
    store.save("instructions:demo", "operator wording");
    store.seed(shipped("second"));

    const entry = store.entry("instructions:demo");
    expect(entry.body).toBe("operator wording");
    expect(entry.customised).toBe(true);
    // Seeded from the version it forked from; shipped has moved on — that gap IS the divergence.
    expect(entry.seededVersion).toBe(promptVersion("first"));
    expect(entry.shippedVersion).toBe(promptVersion("second"));
    expect(entry.shippedBody).toBe("second");
  });

  it("reverts an edited entry to the shipped body and clears the customised mark", () => {
    const store = freshStore();
    store.seed(shipped("first"));
    store.save("instructions:demo", "operator wording");
    store.seed(shipped("second"));

    const reverted = store.revert("instructions:demo");
    expect(reverted.body).toBe("second");
    expect(reverted.customised).toBe(false);
    expect(reverted.seededVersion).toBe(promptVersion("second"));
    expect(store.entry("instructions:demo").customised).toBe(false);
  });

  it("refuses an invalid skill body on save and leaves the stored body whole", () => {
    const store = freshStore();
    store.seed(shipped("first"));

    for (const [invalid, reason] of [
      ["no frontmatter at all", "missing its YAML frontmatter"],
      ["---\ndescription: no name here\n---\nbody", "must declare a name and a description"],
      ["---\nname: Demo Skill\ndescription: Bad name shape.\n---\nbody", "not a valid skill"],
      ["---\n\tname: tabbed\n---\nbody", "invalid YAML frontmatter"],
    ] as const) {
      expect(() => store.save("skill:demo", invalid), invalid).toThrow(reason);
    }
    // The negative criterion: a refused save never leaves an agent resolving a partial prompt.
    expect(store.resolve("skill:demo")).toBe(SKILL_BODY);
    expect(store.entry("skill:demo").customised).toBe(false);
    expect(() => store.resolveSkill("skill:demo")).not.toThrow();
  });

  it("refuses empty instructions and an unknown entry rather than guessing", () => {
    const store = freshStore();
    store.seed(shipped("first"));

    expect(() => store.save("instructions:demo", "   \n ")).toThrow("must not be empty");
    expect(store.resolve("instructions:demo")).toBe("first");
    expect(() => store.resolve("instructions:nonexistent")).toThrow("no prompt store entry");
    expect(() => store.save("instructions:nonexistent", "x")).toThrow("no prompt store entry");
  });

  it("rebuilds the stored skill document into a mountable skill reference with its shipped files", () => {
    const store = freshStore();
    store.seed(shipped("first"));

    const reference = store.resolveSkill("skill:demo", { "references/extra.md": "# extra" });
    expect(reference).toMatchObject({ __flueSkillReference: true, name: "demo-skill" });
    expect(() => store.resolveSkill("instructions:demo")).toThrow("is not a skill");
  });
});

describe("the durable prompt store", () => {
  it("survives a restart and keeps the customised mark across it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ambient-prompt-store-"));
    const databasePath = join(directory, "managed-config.sqlite");
    try {
      const first = createManagedConfigStore(databasePath);
      const store = createPromptStore(first.promptRows);
      store.seed(shipped("first"));
      store.save("instructions:demo", "operator wording");
      first.close();

      const second = createManagedConfigStore(databasePath);
      const reopened = createPromptStore(second.promptRows);
      // A new boot of the same build re-seeds; the edit survives it.
      reopened.seed(shipped("second"));
      const entry = reopened.entry("instructions:demo");
      expect(entry.body).toBe("operator wording");
      expect(entry.customised).toBe(true);
      expect(entry.seededVersion).toBe(promptVersion("first"));
      expect(entry.shippedVersion).toBe(promptVersion("second"));
      expect(reopened.list().map(({ id }) => id)).toEqual(["instructions:demo", "skill:demo"]);

      expect(reopened.revert("instructions:demo").body).toBe("second");
      second.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("shows a second process's edit to an already-open store, with no restart", async () => {
    // The production topology, and the whole "editing a prompt is not a release" claim: the CLI
    // writes through its own connection while the runtime holds its own open. A restart-only store
    // would pass every other test in this file and still break the product.
    const directory = await mkdtemp(join(tmpdir(), "ambient-prompt-live-"));
    const databasePath = join(directory, "managed-config.sqlite");
    try {
      const runtime = createManagedConfigStore(databasePath);
      const runtimeStore = createPromptStore(runtime.promptRows);
      runtimeStore.seed(shipped("first"));

      const cli = createManagedConfigStore(databasePath);
      createPromptStore(cli.promptRows).save("instructions:demo", "edited by the other process");
      cli.close();

      expect(runtimeStore.resolve("instructions:demo")).toBe("edited by the other process");
      expect(runtimeStore.entry("instructions:demo").customised).toBe(true);
      runtime.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses a hand-edited row of an unknown kind, and an emptied body, rather than serving it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ambient-prompt-corrupt-"));
    const databasePath = join(directory, "managed-config.sqlite");
    try {
      const managed = createManagedConfigStore(databasePath);
      createPromptStore(managed.promptRows).seed(shipped("first"));
      managed.close();

      const corrupt = new DatabaseSync(databasePath);
      corrupt.exec("UPDATE managed_prompt SET kind = 'bogus' WHERE id = 'skill:demo'");
      corrupt.exec("UPDATE managed_prompt SET body = '' WHERE id = 'instructions:demo'");
      corrupt.close();

      const reopened = createManagedConfigStore(databasePath);
      const store = createPromptStore(reopened.promptRows);
      // Fail closed on both: guessing the kind would let an invalid skill through, and an empty
      // instruction block is an agent running with no instructions at all — invisible in a reply.
      expect(() => store.resolve("skill:demo")).toThrow("unknown kind");
      expect(() => store.list()).toThrow("unknown kind");
      expect(() => store.resolve("instructions:demo")).toThrow("must not be empty");
      reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("the prompt CLI", () => {
  it("lists, edits, refuses, and reverts against a seeded data directory", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "ambient-prompt-cli-"));
    let stdout = "";
    const output = { stdout: (text: string) => (stdout += text), stderr: (text: string) => (stdout += text) };
    const cli = async (...args: string[]) => await runCli([...args, "--data-dir", dataDirectory], { output });
    try {
      // Nothing has booted this data directory yet: the store is empty and says so.
      expect(await cli("prompt", "list")).toBe(0);
      expect(stdout).toContain("prompt store is empty");

      // The runtime is the process that seeds; do what it does at boot.
      const managed = createManagedConfigStore(join(dataDirectory, "managed-config.sqlite"));
      createPromptStore(managed.promptRows).seed(SHIPPED_PROMPTS);
      managed.close();

      stdout = "";
      expect(await cli("prompt", "list")).toBe(0);
      expect(stdout).toContain(PROMPT_IDS.speaker);
      expect(stdout).toContain("shipped ");

      const edit = join(dataDirectory, "speaker.txt");
      await writeFile(edit, "CLI-NONCE instructions.", "utf8");
      stdout = "";
      expect(await cli("prompt", "set", PROMPT_IDS.speaker, edit)).toBe(0);
      expect(stdout).toContain("now customised");
      stdout = "";
      await cli("prompt", "show", PROMPT_IDS.speaker);
      expect(stdout).toBe("CLI-NONCE instructions.\n");
      stdout = "";
      await cli("prompt", "list");
      expect(stdout).toContain("customised (seeded from");

      // An invalid skill body is refused at the surface, and the stored body is untouched. The
      // refusal must name the entry and the reason — any non-zero exit would pass a bare check.
      const bad = join(dataDirectory, "bad-skill.md");
      await writeFile(bad, "no frontmatter here", "utf8");
      stdout = "";
      expect(await cli("prompt", "set", PROMPT_IDS.whatsappParticipationSkill, bad)).not.toBe(0);
      expect(stdout).toContain(PROMPT_IDS.whatsappParticipationSkill);
      expect(stdout).toContain("missing its YAML frontmatter");
      stdout = "";
      await cli("prompt", "show", PROMPT_IDS.whatsappParticipationSkill);
      expect(stdout).toContain("name: whatsapp-participation");
      stdout = "";
      await cli("prompt", "list");
      expect(stdout).not.toContain(`${PROMPT_IDS.whatsappParticipationSkill}  skill         customised`);

      // An unknown id is refused rather than silently created.
      expect(await cli("prompt", "show", "instructions:nonexistent")).not.toBe(0);

      // --shipped is the diff-view input a customised entry depends on.
      stdout = "";
      await cli("prompt", "show", PROMPT_IDS.speaker, "--shipped");
      expect(stdout).toContain("You are Speaker");
      expect(stdout).not.toContain("CLI-NONCE");

      stdout = "";
      expect(await cli("prompt", "revert", PROMPT_IDS.speaker)).toBe(0);
      expect(stdout).toContain("Reverted");
      stdout = "";
      await cli("prompt", "show", PROMPT_IDS.speaker);
      expect(stdout).toContain("You are Speaker");
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });
});

describe("every role's prompts", () => {
  beforeEach(() => {
    // A fresh store per test; the catalog seeds it from the shipped prompts on first use.
    configurePromptStore(freshStore());
  });

  it("covers every mounted role and skill in the shipped catalog", () => {
    const ids = promptStore()
      .list()
      .map(({ id }) => id);
    expect(ids.sort()).toEqual([...Object.values(PROMPT_IDS)].sort());
    expect(SHIPPED_PROMPTS).toHaveLength(Object.keys(PROMPT_IDS).length);
    for (const entry of promptStore().list()) expect(entry.body.trim(), entry.id).not.toBe("");
  });

  it("leaves no agent prose compiled into an agent module", async () => {
    // The set-equality check above only proves the catalog agrees with itself: a role that hardcodes
    // its prompt touches neither PROMPT_IDS nor SHIPPED_PROMPTS, so nothing there notices. This is
    // the assertion that actually enforces "for EVERY role" — it reads the agent modules and refuses
    // a literal `instructions:` or `skills: [` that does not go through the store.
    const roots = ["packages/agents/src", "tests/fixtures/speaker/src/agents"];
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of await agentModules(join(process.cwd(), root))) {
        const source = await readFile(file, "utf8");
        const relative = file.slice(process.cwd().length + 1);
        for (const [line, text] of source.split("\n").entries()) {
          const declaration = /^\s*(instructions|skills):\s*(.*)$/u.exec(text);
          if (declaration === null) continue;
          const value = declaration[2] ?? "";
          // Only a literal counts: prose is `instructions: "…"` or `instructions: [ … ].join()`.
          // `instructions: v.optional(…)` in coder/schemas.ts is a request field, not agent prose.
          if (!/^["'[]/u.test(value)) continue;
          // The rubric judge is an eval judge, not a coworker role; it grades prompts, it is not one.
          if (relative.endsWith("agents/rubric-judge.ts")) continue;
          if (value.includes("storedInstructions(") || value.includes("storedSkill(")) continue;
          offenders.push(`${relative}:${line + 1} ${text.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("resolves the Speaker's instructions and participation skill from the store", () => {
    const store = promptStore();
    store.save(PROMPT_IDS.speaker, "SPEAKER-NONCE instructions.");
    const config = speakerRuntimeConfig("chat@g.us");

    expect(config.instructions).toBe("SPEAKER-NONCE instructions.");
    expect(config.skills?.[0]).toMatchObject({ name: "whatsapp-participation" });

    store.revert(PROMPT_IDS.speaker);
    expect(speakerRuntimeConfig("chat@g.us").instructions).toContain("You are Speaker");
  });

  it("resolves the Brain's instructions from the store", () => {
    promptStore().save(PROMPT_IDS.brain, "BRAIN-NONCE instructions.");
    expect(brainRuntimeConfig().instructions).toBe("BRAIN-NONCE instructions.");
  });

  it("resolves both Scribe configurations from the store", async () => {
    const store = promptStore();
    store.save(PROMPT_IDS.scribeSuperseded, "SUPERSEDED-NONCE.");
    store.save(PROMPT_IDS.scribe, "SCRIBE-NONCE.");

    expect(scribeAttemptRuntimeConfig("scribe-attempt:orphan").instructions).toBe("SUPERSEDED-NONCE.");
    await withScribeAttemptContext(
      "scribe-attempt:live",
      { author: { kind: "scribe", id: "scribe" }, evidenceIds: ["arrival:live"], batchId: "scribe-batch:live" },
      async () => {
        const live = scribeAttemptRuntimeConfig("scribe-attempt:live");
        expect(live.instructions).toBe("SCRIBE-NONCE.");
        expect(live.skills?.[0]).toMatchObject({ name: "graph-extraction" });
      },
    );
  });

  it("resolves the Planner, Coder, and Verifier role profiles from the store", () => {
    const store = promptStore();
    store.save(PROMPT_IDS.planner, "PLANNER-NONCE.");
    store.save(PROMPT_IDS.coder, "CODER-NONCE.");
    store.save(PROMPT_IDS.verifier, "VERIFIER-NONCE.");

    expect(
      roleProfiles().map((profile) => [profile.name, profile.instructions, (profile.skills?.[0] as { name?: string })?.name]),
    ).toEqual([
      ["planner", "PLANNER-NONCE.", "planner"],
      ["coder", "CODER-NONCE.", "coder"],
      ["verifier", "VERIFIER-NONCE.", "verify"],
    ]);
  });

  it("resolves the coding workflow's unprompted root coordinator from the store", () => {
    configureCoderRuntime({ github: (() => { throw new Error("unused"); }) as never, sandbox: (() => ({})) as never, workspacesRoot: "/tmp" });
    promptStore().save(PROMPT_IDS.coderCoordinator, "COORDINATOR-NONCE.");
    expect(coderRuntimeConfig().instructions).toBe("COORDINATOR-NONCE.");
  });

  it("resolves the Reviewer's instructions and skill from the store", () => {
    configureReviewerRuntime({
      github: (() => {
        throw new Error("unused");
      }) as never,
      sandbox: (() => ({})) as never,
      workspacesRoot: "/tmp",
    });
    promptStore().save(PROMPT_IDS.reviewer, "REVIEWER-NONCE.");
    const config = reviewerRuntimeConfig();

    expect(config.instructions).toBe("REVIEWER-NONCE.");
    expect(config.skills[0]).toMatchObject({ name: "reviewer" });
  });

  it("keeps an edited skill body mountable and reverts it", () => {
    const store = promptStore();
    const edited = store.resolve(PROMPT_IDS.whatsappParticipationSkill).replace("# ", "OPERATOR-NONCE\n\n# ");
    store.save(PROMPT_IDS.whatsappParticipationSkill, edited);

    expect(store.entry(PROMPT_IDS.whatsappParticipationSkill).customised).toBe(true);
    expect(speakerRuntimeConfig("chat@g.us").skills?.[0]).toMatchObject({ name: "whatsapp-participation" });
    expect(store.resolve(PROMPT_IDS.whatsappParticipationSkill)).toContain("OPERATOR-NONCE");

    store.revert(PROMPT_IDS.whatsappParticipationSkill);
    const reverted = store.entry(PROMPT_IDS.whatsappParticipationSkill);
    expect(reverted.customised).toBe(false);
    expect(reverted.body).not.toContain("OPERATOR-NONCE");
    expect(reverted.seededVersion).toBe(reverted.shippedVersion);
  });
});
