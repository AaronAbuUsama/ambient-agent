import { readFileSync } from "node:fs";
import { z } from "zod";
import { loadAppConfig, type AppConfig } from "../app/config";
import { createAmbientProofHarness } from "../app/proof";
import { RIG_PRIVATE, rigConfig } from "./rig";

/**
 * Offline memory-digest proof: import the blessed test-bed chat's history
 * from the designated mirror, digest it as sequential windowed memory jobs,
 * drain the evaluation runner, and grade the resulting ontology against the
 * operator-editable golden reference — first on the rig database, then
 * shipped into the production database. No WhatsApp connection is opened and
 * nothing can be sent. The receipt carries statuses, counts, and scores only.
 */
const testbedSchema = z.object({
  memoryTestbed: z.object({
    chats: z.array(z.string().min(1)).min(1),
    mirror: z.string().min(1).default("file:data/whatsapp.db"),
    mirrorAccountId: z.string().min(1).default("main"),
  }),
});

/** The mechanical slice of the golden reference; the rest is for humans. */
const goldenSchema = z.object({
  grading: z.object({
    mustFind: z
      .array(z.object({ label: z.string().min(1), patterns: z.array(z.string().min(1)).min(1) }))
      .min(1),
    minimumFound: z.number().int().positive(),
    mustNotLinkSuffixes: z.array(z.string().min(1)),
    minimumIssueEntities: z.number().int().nonnegative(),
    minimumPersonEntities: z.number().int().nonnegative(),
  }),
});

const testbed = testbedSchema.parse(
  JSON.parse(readFileSync(`${RIG_PRIVATE}/memory-testbed.json`, "utf8")),
).memoryTestbed;
const chatId = testbed.chats[0]!;
const golden = goldenSchema.parse(
  JSON.parse(readFileSync(`${RIG_PRIVATE}/memory-golden.json`, "utf8")),
).grading;

async function digestInto(
  label: string,
  config: AppConfig,
  receipt: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // Registered up front so a failing gate still leaves its partial evidence.
  const section: Record<string, unknown> = {};
  receipt[label] = section;
  const harness = await createAmbientProofHarness(config, {});
  try {
    const imported = await harness.importHistory({
      mirrorUrl: testbed.mirror,
      mirrorAccountId: testbed.mirrorAccountId,
      chatId,
      limit: 1000,
    });
    section["import"] = imported;

    const digest = await harness.requestMemoryDigest(chatId);
    section["digest"] = {
      outcome: digest.outcome,
      jobs: digest.jobs,
      runs: digest.runIds.length,
      batchSize: digest.batchSize,
      senders: digest.senders.length,
    };
    if (digest.outcome !== "done") throw new Error(`${label}: memory digest did not complete`);

    let processed = 0;
    while ((await harness.runEvaluationsOnce()) === "processed") processed += 1;
    section["evaluationsProcessed"] = processed;

    // Every window's contract must hold deterministically. Judged scores are
    // gated in aggregate: a small window makes one judge verdict worth 0.1+,
    // so the bar is a strong mean with a per-window floor, not a brittle
    // per-window threshold.
    const faithfulnessScores: number[] = [];
    const completenessScores: number[] = [];
    const runEvaluations: unknown[] = [];
    for (const runId of digest.runIds) {
      const details = await harness.evidence.evaluationDetails(runId);
      runEvaluations.push(
        details.map(({ caseId, status, results }) => ({ caseId, status, results })),
      );
      const contract = details.find(({ caseId }) => caseId === "memory-contract-v1");
      for (const metric of ["grounded_claims", "audience_scope", "identity_scope"]) {
        const result = contract?.results.find((row) => row.metric === metric);
        if (result?.passed !== true) throw new Error(`${label}: contract metric ${metric} failed`);
      }
      const judged = details.find(({ caseId }) => caseId === "memory-judged-v1");
      if (judged && judged.status === "succeeded") {
        const faithfulness = judged.results.find(({ metric }) => metric === "memory_faithfulness");
        if (faithfulness?.score !== undefined) faithfulnessScores.push(faithfulness.score);
        const completeness = judged.results.find(({ metric }) => metric === "memory_completeness");
        if (completeness?.score !== undefined) completenessScores.push(completeness.score);
      }
    }
    section["evaluations"] = runEvaluations;
    section["judgedFaithfulness"] = faithfulnessScores;
    section["judgedCompleteness"] = completenessScores;
    const mean = (scores: readonly number[]) =>
      scores.length === 0 ? 1 : scores.reduce((sum, score) => sum + score, 0) / scores.length;
    if (faithfulnessScores.some((score) => score < 0.7)) {
      throw new Error(`${label}: a window's judged faithfulness fell below the 0.7 floor`);
    }
    if (mean(faithfulnessScores) < 0.85) {
      throw new Error(`${label}: aggregate judged faithfulness below 0.85`);
    }
    if (mean(completenessScores) < 0.7) {
      throw new Error(`${label}: aggregate judged completeness below 0.7`);
    }

    // The golden gate: the ontology must carry the reference the operator
    // labeled, and must never link a chat id as an identity.
    const recalled = await harness.recallForConversation(chatId);
    section["recalledClaims"] = recalled.length;
    if (recalled.length === 0) throw new Error(`${label}: recall returned nothing`);
    const texts = recalled.map(({ text }) => text.toLocaleLowerCase());
    const found = golden.mustFind.filter(({ patterns }) =>
      texts.some((text) => patterns.every((pattern) => text.includes(pattern.toLocaleLowerCase()))),
    );
    const missing = golden.mustFind
      .filter((entry) => !found.includes(entry))
      .map(({ label: entryLabel }) => entryLabel);
    section["golden"] = {
      found: found.length,
      total: golden.mustFind.length,
      minimum: golden.minimumFound,
      missing,
    };

    const summary = await harness.ontologySummary();
    section["ontology"] = {
      entitiesByKind: summary.entitiesByKind,
      identityLinks: summary.identityNativeIds.length,
      claims: summary.claimCount,
    };
    const poisoned = summary.identityNativeIds.filter((id) =>
      golden.mustNotLinkSuffixes.some((suffix) => id.endsWith(suffix)),
    );
    if (poisoned.length > 0) {
      throw new Error(`${label}: ${poisoned.length} identity links carry a banned suffix`);
    }
    if ((summary.entitiesByKind["issue"] ?? 0) < golden.minimumIssueEntities) {
      throw new Error(`${label}: issue entities below the golden minimum`);
    }
    if ((summary.entitiesByKind["person"] ?? 0) < golden.minimumPersonEntities) {
      throw new Error(`${label}: person entities below the golden minimum`);
    }
    if (found.length < golden.minimumFound) {
      throw new Error(
        `${label}: golden coverage ${found.length}/${golden.mustFind.length} below minimum ${golden.minimumFound}`,
      );
    }
    return section;
  } finally {
    await harness.stop();
  }
}

// One full run exceeds a ten-minute window; `rig` / `production` run half each.
const target = process.argv[2] ?? "both";
const receipt: Record<string, unknown> = {};
try {
  const rig = rigConfig(loadAppConfig());
  if (target !== "production") await digestInto("rig", rig, receipt);

  // The ship: the same import and digest against the production database, so
  // the group's memory exists where the production speaker will recall it.
  const base = loadAppConfig();
  if (target !== "rig") await digestInto("production", { ...base, models: rig.models }, receipt);
} finally {
  console.info(JSON.stringify(receipt, null, 2));
}
