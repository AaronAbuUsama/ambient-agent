import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { runCli, type CliOutput } from "../../apps/cli/src/program.ts";
import {
  serializeEvaluationScenarioEvidence,
  validateEvaluationScenario,
} from "../../packages/engine/src/evaluation/scenario.ts";

const fixture = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(join(process.cwd(), "tests/fixtures/evaluation-scenarios", `${name}.json`), "utf8"));

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const cliOutput = (): { output: CliOutput; stdout: () => string; stderr: () => string } => {
  let stdout = "";
  let stderr = "";
  return {
    output: {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
};

describe("Evaluation Scenario repository artifacts", () => {
  it("normalizes a valid public scenario without claiming restricted holdout membership", async () => {
    const positive = (await fixture("positive")) as Record<string, unknown>;
    const positiveFixture = positive.fixture as Record<string, unknown>;
    const evidence = validateEvaluationScenario(positive);

    expect(evidence.normalizedScenario.maturity).toBe("capability");
    expect(evidence.normalizedScenario.holdoutMemberships).toHaveLength(0);
    expect(evidence.fixtureDigest).toBe(
      "sha256:5a3beca1a771070a4c05faca73fcef5c87584c7c400de10c13ba7256e9fa16b9",
    );
    expect(() =>
      validateEvaluationScenario({
        ...positive,
        fixture: { ...positiveFixture, ref: "tests/fixtures/evaluation-scenarios/missing.json" },
      }),
    ).toThrow("fixture does not resolve");
    expect(() =>
      validateEvaluationScenario({
        ...positive,
        fixture: { ...positiveFixture, sha256: "0".repeat(64) },
      }),
    ).toThrow("fixture SHA-256 does not match");
    const fixtureBoundary = await mkdtemp(join(tmpdir(), "evaluation-fixture-boundary-"));
    roots.push(fixtureBoundary);
    const repositoryRoot = join(fixtureBoundary, "repository");
    const externalFixture = join(fixtureBoundary, "external.json");
    await mkdir(repositoryRoot);
    await writeFile(externalFixture, "{}\n");
    await symlink(externalFixture, join(repositoryRoot, "fixture.json"));
    expect(() =>
      validateEvaluationScenario(
        {
          ...positive,
          fixture: {
            ...positiveFixture,
            ref: "fixture.json",
            sha256: "ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356",
          },
        },
        { repositoryRoot },
      ),
    ).toThrow("fixture must be a file inside the repository");
    const unsafeFixture = JSON.stringify({ messages: ["customer@example.com"], token: "secret" });
    await writeFile(join(repositoryRoot, "unsafe.json"), unsafeFixture);
    expect(() =>
      validateEvaluationScenario(
        {
          ...positive,
          fixture: {
            ...positiveFixture,
            ref: "unsafe.json",
            sha256: createHash("sha256").update(unsafeFixture).digest("hex"),
          },
        },
        { repositoryRoot },
      ),
    ).toThrow("Unsafe inline production content");
    const genericTextFixture = JSON.stringify({ events: [{ text: "copied private conversation" }] });
    await writeFile(join(repositoryRoot, "generic-text.json"), genericTextFixture);
    expect(() =>
      validateEvaluationScenario(
        {
          ...positive,
          fixture: {
            ...positiveFixture,
            ref: "generic-text.json",
            sha256: createHash("sha256").update(genericTextFixture).digest("hex"),
          },
        },
        { repositoryRoot },
      ),
    ).toThrow("$fixture.events[0].text");
    const invalidFixture = "not json\n";
    await writeFile(join(repositoryRoot, "invalid.json"), invalidFixture);
    expect(() =>
      validateEvaluationScenario(
        {
          ...positive,
          fixture: {
            ...positiveFixture,
            ref: "invalid.json",
            sha256: createHash("sha256").update(invalidFixture).digest("hex"),
          },
        },
        { repositoryRoot },
      ),
    ).toThrow("fixture must be sanitized JSON");
    const syntheticMembership = {
      datasetId: "synthetic-membership-shape",
      accessPolicyId: "synthetic-access-policy",
      admittedBy: ["evaluation-owner"],
      admittedAt: "2026-07-26T00:00:00Z",
    };
    const memberEvidence = validateEvaluationScenario({
      ...evidence.normalizedScenario,
      holdoutMemberships: [syntheticMembership],
    });
    expect(memberEvidence.normalizedScenario.maturity).toBe("capability");
    expect(memberEvidence.normalizedScenario.holdoutMemberships[0]?.accessPolicyId).toBe("synthetic-access-policy");
    expect(() =>
      validateEvaluationScenario({
        ...evidence.normalizedScenario,
        holdoutMemberships: [{ ...syntheticMembership, accessPolicyId: "" }],
      }),
    ).toThrow("accessPolicyId");
    expect(evidence.evidenceId).toContain(evidence.scenarioId);
    expect(serializeEvaluationScenarioEvidence(evidence)).toBe(serializeEvaluationScenarioEvidence(evidence));
  });

  it("accepts explicit draft gaps and rejects them once adjudicated", async () => {
    const draft = (await fixture("pressure")) as Record<string, unknown>;
    draft.expectations = {
      ...(draft.expectations as Record<string, unknown>),
      prohibitedOutcomes: { unresolved: "pending adjudication" },
    };

    expect(validateEvaluationScenario(draft).normalizedScenario.lifecycle).toBe("draft");
    expect(() => validateEvaluationScenario({ ...draft, lifecycle: "adjudicated" })).toThrow(
      "Only a draft Evaluation Scenario may contain explicitly unresolved fields",
    );
  });

  it("rejects missing epoch and owner through the public validator", async () => {
    const negative = await fixture("negative");
    expect(() => validateEvaluationScenario(negative)).toThrow(/architectureEpoch.*owners/su);
  });

  it("rejects unsafe inline production content and invalid lifecycle combinations", async () => {
    const pressure = await fixture("pressure");
    expect(() => validateEvaluationScenario(pressure)).toThrow("Unsafe inline production content");
    const valid = (await fixture("positive")) as Record<string, unknown>;
    expect(() => validateEvaluationScenario({ ...valid, maturity: "retired" })).toThrow(
      "Retired maturity requires retirement details",
    );
    expect(() =>
      validateEvaluationScenario({
        ...valid,
        retirement: { reason: "not retired", replacementScenarioIds: [] },
      }),
    ).toThrow("other maturities prohibit them");
    expect(() => validateEvaluationScenario({ ...valid, lifecycle: "draft" })).toThrow(
      "A draft Evaluation Scenario must have candidate maturity",
    );
    expect(() => validateEvaluationScenario({ ...valid, transcript: ["raw production content"] })).toThrow(
      "Unsafe inline production content",
    );
  });

  it.each([
    "credential sk-inline-secret-value",
    "customer@example.com",
    "call +1 202 555 0199",
    "120363000000@g.us",
    "https://provider.example/private",
    "customer: copied conversation text",
    "first line\nsecond line",
  ])("rejects unsafe schema-valid content: %s", async (unsafe) => {
    const valid = (await fixture("positive")) as Record<string, unknown>;
    expect(() => validateEvaluationScenario({ ...valid, title: unsafe })).toThrow("Unsafe inline production content");
  });

  it("validates through the CLI, emits exact local evidence, and never touches managed runtime state", async () => {
    const root = await mkdtemp(join(tmpdir(), "evaluation-scenario-"));
    roots.push(root);
    const input = join(root, "scenario.json");
    const localEvidence = join(root, "evidence.json");
    const scenario = (await fixture("positive")) as Record<string, unknown>;
    scenario.scenarioId = "scenario-runtime-nonce";
    await writeFile(input, JSON.stringify(scenario));
    const cli = cliOutput();

    expect(
      await runCli(
        [
          "evaluation-scenario",
          "validate",
          input,
          "--output",
          localEvidence,
          "--repository-root",
          process.cwd(),
        ],
        {
        output: cli.output,
        migrateManagedData: async () => {
          throw new Error("repository artifact validation invoked managed-data migration");
        },
        },
      ),
    ).toBe(0);
    expect(cli.stderr()).toBe("");
    expect(await readFile(localEvidence, "utf8")).toBe(cli.stdout());
    expect(cli.stdout()).toContain("scenario-runtime-nonce");
  });

  it("derives the repository root from the artifact path", async () => {
    const cli = cliOutput();
    const path = join(process.cwd(), "tests/fixtures/evaluation-scenarios/positive.json");

    expect(await runCli(["evaluation-scenario", "validate", path], { output: cli.output })).toBe(0);
    expect(cli.stderr()).toBe("");
    expect(cli.stdout()).toContain("scenario-synthetic-positive");
  });

  it("rejects a detached artifact unless its repository root is explicit", async () => {
    const root = await mkdtemp(join(tmpdir(), "evaluation-scenario-detached-"));
    roots.push(root);
    const input = join(root, "scenario.json");
    await writeFile(input, JSON.stringify(await fixture("positive")));
    const cli = cliOutput();

    expect(await runCli(["evaluation-scenario", "validate", input], { output: cli.output })).toBe(1);
    expect(cli.stderr()).toContain("Could not find the repository root");
  });

  it.each(["negative", "pressure"])("rejects the %s fixture through the CLI", async (name) => {
    const cli = cliOutput();
    const path = join(process.cwd(), "tests/fixtures/evaluation-scenarios", `${name}.json`);

    expect(await runCli(["evaluation-scenario", "validate", path], { output: cli.output })).toBe(1);
    expect(cli.stdout()).toBe("");
    expect(cli.stderr()).toMatch(name === "negative" ? /architectureEpoch.*owners/su : /Unsafe inline production content/u);
  });
});
