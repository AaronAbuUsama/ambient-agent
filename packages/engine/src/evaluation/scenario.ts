import { createHash } from "node:crypto";
import * as v from "valibot";

const NonBlankString = v.pipe(v.string(), v.trim(), v.nonEmpty());
const NonEmptyStrings = v.pipe(v.array(NonBlankString), v.nonEmpty());
const RepositoryReference = v.pipe(
  NonBlankString,
  v.check(
    (reference) =>
      !reference.startsWith("/") &&
      !reference.split("/").includes("..") &&
      !/^[a-z][a-z0-9+.-]*:/iu.test(reference),
    "Expected a repository-relative fixture reference",
  ),
);
const Timestamp = v.pipe(
  NonBlankString,
  v.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u, "Expected an ISO 8601 UTC timestamp"),
);
const Unresolved = v.strictObject({ unresolved: NonBlankString });
const requiredOrUnresolved = <TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(schema: TSchema) =>
  v.union([schema, Unresolved]);

const ArchitectureEpoch = v.strictObject({
  canonCommit: v.pipe(NonBlankString, v.regex(/^[0-9a-f]{7,40}$/u, "Expected a canon commit SHA")),
  decisions: NonEmptyStrings,
  schemaVersion: v.literal(1),
});
const HoldoutMembership = v.strictObject({
  datasetId: NonBlankString,
  accessPolicyId: NonBlankString,
  admittedBy: NonEmptyStrings,
  admittedAt: Timestamp,
});
const Provenance = v.strictObject({
  kind: v.picklist(["operator_correction", "production_failure", "issue", "designed_boundary"]),
  restrictedSourceRefs: NonEmptyStrings,
  sanitizedBy: NonBlankString,
  sanitizationVersion: NonBlankString,
  adjudicatedBy: NonEmptyStrings,
  adjudicatedAt: Timestamp,
});
const Fixture = v.strictObject({
  ref: RepositoryReference,
  environmentVersion: NonBlankString,
});
const Expectations = v.strictObject({
  requiredInvariants: requiredOrUnresolved(NonEmptyStrings),
  allowedOutcomes: requiredOrUnresolved(NonEmptyStrings),
  prohibitedOutcomes: requiredOrUnresolved(NonEmptyStrings),
  semanticDimensions: v.array(NonBlankString),
});
const Scorer = v.strictObject({
  id: NonBlankString,
  version: NonBlankString,
  kind: v.picklist(["deterministic", "model_judge", "human"]),
  owner: NonBlankString,
});
const Retirement = v.strictObject({
  reason: NonBlankString,
  replacementScenarioIds: v.array(NonBlankString),
});

const isUnresolved = (value: unknown): value is v.InferOutput<typeof Unresolved> =>
  typeof value === "object" && value !== null && "unresolved" in value;

export const EvaluationScenarioSchema = v.pipe(
  v.strictObject({
    schemaVersion: v.literal(1),
    scenarioId: v.pipe(
      NonBlankString,
      v.regex(/^[a-z0-9][a-z0-9._:-]*$/u, "Expected a stable lowercase scenario identifier"),
    ),
    title: NonBlankString,
    lifecycle: v.picklist(["draft", "adjudicated"]),
    architectureEpoch: requiredOrUnresolved(ArchitectureEpoch),
    maturity: v.picklist(["candidate", "capability", "regression", "retired"]),
    holdoutMemberships: v.array(HoldoutMembership),
    owners: requiredOrUnresolved(NonEmptyStrings),
    slices: NonEmptyStrings,
    provenance: requiredOrUnresolved(Provenance),
    fixture: requiredOrUnresolved(Fixture),
    expectations: Expectations,
    scorers: requiredOrUnresolved(v.pipe(v.array(Scorer), v.nonEmpty())),
    retirement: v.optional(Retirement),
  }),
  v.check(
    (scenario) =>
      scenario.lifecycle === "draft" ||
      ![
        scenario.architectureEpoch,
        scenario.owners,
        scenario.provenance,
        scenario.fixture,
        scenario.expectations.requiredInvariants,
        scenario.expectations.allowedOutcomes,
        scenario.expectations.prohibitedOutcomes,
        scenario.scorers,
      ].some(isUnresolved),
    "Only a draft Evaluation Scenario may contain explicitly unresolved fields",
  ),
  v.check(
    (scenario) => scenario.lifecycle !== "draft" || scenario.maturity === "candidate",
    "A draft Evaluation Scenario must have candidate maturity",
  ),
  v.check(
    (scenario) => (scenario.maturity === "retired") === (scenario.retirement !== undefined),
    "Retired maturity requires retirement details, and other maturities prohibit them",
  ),
);

export type EvaluationScenario = v.InferOutput<typeof EvaluationScenarioSchema>;

export interface EvaluationScenarioValidationEvidence {
  readonly evidenceSchemaVersion: 1;
  readonly evidenceId: string;
  readonly scenarioId: string;
  readonly scenarioSchemaVersion: 1;
  readonly normalizedScenario: EvaluationScenario;
}

const INLINE_CONTENT_KEYS = new Set([
  "body",
  "content",
  "conversation",
  "cookie",
  "credential",
  "credentials",
  "message",
  "messages",
  "payload",
  "privatekey",
  "prompt",
  "session",
  "token",
  "toolarguments",
  "toolresults",
  "transcript",
]);
const SECRET_VALUE =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{8,}|(?:github_pat_|gh[oprsu]_)[A-Za-z0-9_]+/u;

const unsafeInlinePath = (value: unknown, path = "$"): string | undefined => {
  if (typeof value === "string") return SECRET_VALUE.test(value) ? path : undefined;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const unsafe = unsafeInlinePath(item, `${path}[${index}]`);
      if (unsafe !== undefined) return unsafe;
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  for (const [key, item] of Object.entries(value)) {
    const itemPath = `${path}.${key}`;
    if (INLINE_CONTENT_KEYS.has(key.toLowerCase())) return itemPath;
    const unsafe = unsafeInlinePath(item, itemPath);
    if (unsafe !== undefined) return unsafe;
  }
  return undefined;
};

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]),
  );
};

export const serializeEvaluationScenarioEvidence = (evidence: EvaluationScenarioValidationEvidence): string =>
  `${JSON.stringify(canonicalValue(evidence), null, 2)}\n`;

export const validateEvaluationScenario = (input: unknown): EvaluationScenarioValidationEvidence => {
  const unsafe = unsafeInlinePath(input);
  if (unsafe !== undefined) {
    throw new Error(`Unsafe inline production content or credential material at ${unsafe}; store a sanitized reference instead.`);
  }
  const result = v.safeParse(EvaluationScenarioSchema, input);
  if (!result.success) {
    const issues = result.issues
      .map((issue) => {
        const path = issue.path?.map((item) => String(item.key)).join(".");
        return `${path === undefined || path.length === 0 ? "$" : path}: ${issue.message}`;
      })
      .join("; ");
    throw new Error(`Invalid Evaluation Scenario: ${issues}`);
  }
  const normalized = JSON.stringify(canonicalValue(result.output));
  const digest = createHash("sha256").update(normalized).digest("hex");
  return {
    evidenceSchemaVersion: 1,
    evidenceId: `evaluation-scenario-validation:v1:${result.output.scenarioId}:sha256:${digest}`,
    scenarioId: result.output.scenarioId,
    scenarioSchemaVersion: result.output.schemaVersion,
    normalizedScenario: result.output,
  };
};
