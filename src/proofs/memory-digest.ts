import { readFileSync } from "node:fs";
import { z } from "zod";
import { loadAppConfig, type AppConfig } from "../app/config";
import { createAmbientProofHarness } from "../app/proof";
import { RIG_PRIVATE, rigConfig } from "./rig";

/**
 * Offline memory-digest proof: import the blessed test-bed chat's history
 * from the designated mirror, run one live Memory Agent digest, drain the
 * evaluation runner, and verify recall — first on the rig database, then
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
const goldenSchema = z.object({
  mustFind: z.array(z.object({ pattern: z.string().min(1) })).min(1),
});

const testbed = testbedSchema.parse(
  JSON.parse(readFileSync(`${RIG_PRIVATE}/memory-testbed.json`, "utf8")),
).memoryTestbed;
const chatId = testbed.chats[0]!;

async function digestInto(label: string, config: AppConfig): Promise<Record<string, unknown>> {
  const section: Record<string, unknown> = {};
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
      batchSize: digest.batchSize,
      senders: digest.senders.length,
    };
    if (digest.outcome !== "done" || !digest.runId) {
      throw new Error(`${label}: memory digest did not complete`);
    }

    let processed = 0;
    while ((await harness.runEvaluationsOnce()) === "processed") processed += 1;
    section["evaluationsProcessed"] = processed;

    const details = await harness.evidence.evaluationDetails(digest.runId);
    section["evaluations"] = details.map(({ caseId, status, results }) => ({
      caseId,
      status,
      results,
    }));
    const contract = details.find(({ caseId }) => caseId === "memory-contract-v1");
    const grounded = contract?.results.find(({ metric }) => metric === "grounded_claims");
    if (grounded?.passed !== true) throw new Error(`${label}: grounding failed`);
    const judged = details.find(({ caseId }) => caseId === "memory-judged-v1");
    const faithfulness = judged?.results.find(({ metric }) => metric === "memory_faithfulness");
    if (judged && judged.status === "succeeded" && (faithfulness?.score ?? 0) < 0.8) {
      throw new Error(`${label}: judged faithfulness below threshold`);
    }

    const recalled = await harness.recallFor(digest.senders);
    section["recalledClaims"] = recalled.length;
    if (recalled.length === 0) throw new Error(`${label}: recall returned nothing`);

    try {
      const golden = goldenSchema.parse(
        JSON.parse(readFileSync(`${RIG_PRIVATE}/memory-golden.json`, "utf8")),
      );
      const texts = recalled.map(({ text }) => text.toLocaleLowerCase());
      const found = golden.mustFind.filter(({ pattern }) =>
        texts.some((text) => text.includes(pattern.toLocaleLowerCase())),
      ).length;
      section["golden"] = { found, total: golden.mustFind.length };
    } catch {
      section["golden"] = "no golden file yet";
    }
    return section;
  } finally {
    await harness.stop();
  }
}

const receipt: Record<string, unknown> = {};
try {
  const rig = rigConfig(loadAppConfig());
  receipt["rig"] = await digestInto("rig", rig);

  // The ship: the same import and digest against the production database, so
  // the group's memory exists where the production speaker will recall it.
  const base = loadAppConfig();
  receipt["production"] = await digestInto("production", { ...base, models: rig.models });
} finally {
  console.info(JSON.stringify(receipt, null, 2));
}
