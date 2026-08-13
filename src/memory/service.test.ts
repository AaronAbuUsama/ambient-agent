import { expect, test } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAmbientDatabase, type AmbientDatabase } from "../database/database";
import { createEvaluationService } from "../evals/service";
import type { MemoryRunEvidence } from "../evals/contract";
import type { MemoryAgent, MemoryInput, MemoryProposal } from "./contract";
import { createMemoryService } from "./service";

const model = {
  provider: "test",
  model: "deterministic",
  thinking: "off" as const,
  maxOutputTokens: 1024,
};

async function withDatabase(work: (database: AmbientDatabase) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ambient-memory-"));
  const url = `file:${join(directory, "ambient.db")}`;
  const database = await openAmbientDatabase(url);
  try {
    await work(database);
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function retainHistory(
  database: AmbientDatabase,
  id: string,
  senderId: string,
  text: string,
): Promise<void> {
  await database.repositories.observations.retain({
    id: `observation-${id}`,
    source: "whatsapp",
    accountId: "main",
    nativeId: `native-${id}`,
    conversationId: "group-1",
    occurredAt: `2026-07-15T10:0${id}:00.000Z`,
    kind: "message",
    payload: {
      version: 1,
      messageId: `m-${id}`,
      chatId: "group-1",
      sender: { id: senderId, mode: "pn" },
      fromMe: false,
      timestamp: 1752573600000,
      historical: true,
      text,
    },
  });
}

const goodProposal: MemoryProposal = {
  entities: [
    { ref: "e1", kind: "person", canonicalName: "Aye", nativeIds: ["a@s.whatsapp.net"] },
    { ref: "e2", kind: "person", canonicalName: "Bee", nativeIds: ["b@s.whatsapp.net"] },
  ],
  predicates: [{ ref: "p1", name: "works_on", description: "what they work on" }],
  claims: [
    {
      entity: "e1",
      predicate: "p1",
      value: "Lavin",
      confidence: "high",
      evidenceObservationIds: ["observation-1"],
    },
    {
      entity: "e2",
      predicate: "p1",
      value: "checkout bug",
      confidence: "medium",
      evidenceObservationIds: ["observation-2"],
    },
  ],
  report: "Two people identified.",
};

/** A test agent in the real shape: one run, one propose_facts tool call. */
function agentWith(propose: (input: MemoryInput) => Promise<MemoryProposal>): MemoryAgent {
  return {
    model,
    async run(input, tools) {
      const proposal = await propose(input);
      const applied = await tools.proposeFacts(proposal, "tool-call-1");
      return { report: applied.report };
    },
  };
}

function service(database: AmbientDatabase, agent: MemoryAgent) {
  return createMemoryService({
    jobs: database.repositories.memoryJobs,
    agent,
    ontology: database.repositories.memory,
    runs: database.repositories.runs,
    leaseOwner: "memory-test",
  });
}

test("a digest applies validated memory, recall returns it, and evals judge it", async () => {
  await withDatabase(async (database) => {
    await retainHistory(database, "1", "a@s.whatsapp.net", "I run the Lavin project");
    await retainHistory(database, "2", "b@s.whatsapp.net", "The checkout button crashes");
    await database.repositories.memoryJobs.create({
      conversationId: "group-1",
      observationIds: ["observation-1", "observation-2"],
    });

    const runner = service(
      database,
      agentWith(async (input) => {
        expect(input.messages).toHaveLength(2);
        expect(input.entities).toEqual([]);
        return goodProposal;
      }),
    );
    expect((await runner.runOnce()).outcome).toBe("done");

    const recalled = await database.repositories.memory.recall({
      nativeIds: ["a@s.whatsapp.net"],
      query: "",
      limit: 10,
    });
    expect(recalled).toHaveLength(1);
    expect(recalled[0]?.evidenceObservationIds).toEqual(["observation-1"]);

    // The run signalled evaluation; the runner records contract + judged cases.
    const judged: MemoryRunEvidence[] = [];
    const evals = createEvaluationService({
      work: database.repositories.evaluationWork,
      recorder: database.repositories.evaluations,
      memoryJudge: {
        async judge(evidence) {
          judged.push(evidence);
          const run = await database.repositories.runs.start({
            agentId: "evaluator-judge",
            role: "evaluator",
            model,
            promptVersion: "memory-judge-v1",
            input: {},
          });
          await database.repositories.runs.finish(run.id, { status: "succeeded", result: {} });
          return {
            evaluatorRunId: run.id,
            metrics: [{ metric: "memory_faithfulness", score: 1, passed: true, detail: {} }],
          };
        },
      },
      maximumItemsPerRun: 10,
    });
    expect(await evals.runOnce()).toBe("processed");
    expect(judged).toHaveLength(1);
    expect(judged[0]?.appliedClaims).toHaveLength(2);
    expect(judged[0]?.appliedClaims.every((claim) => claim.grounded && claim.inConversation)).toBe(
      true,
    );
    expect(judged[0]?.appliedClaims[0]?.evidenceTexts).toEqual(["I run the Lavin project"]);

    const evaluations = await database.repositories.evaluations.forSubject(judged[0]!.runId);
    expect(evaluations.map(({ caseId, status }) => ({ caseId, status }))).toEqual([
      { caseId: "memory-contract-v1", status: "succeeded" },
      { caseId: "memory-judged-v1", status: "succeeded" },
    ]);
    expect(await evals.runOnce()).toBe("idle");
  });
});

test("unattributed history regains quoted authors, mentions are linkable, chat ids are not", async () => {
  await withDatabase(async (database) => {
    // A historical group row whose author the mirror never synced: no sender,
    // but a later reply quotes it and names its real author.
    await database.repositories.observations.retain({
      id: "observation-1",
      source: "whatsapp",
      accountId: "main",
      nativeId: "native-1",
      conversationId: "group-1@g.us",
      occurredAt: "2026-07-15T10:01:00.000Z",
      kind: "message",
      payload: {
        version: 1,
        messageId: "m-1",
        chatId: "group-1@g.us",
        fromMe: false,
        timestamp: 1752573600000,
        historical: true,
        kind: "text",
        text: "the compass drifts on Android",
        context: { mentions: ["androiddev@lid"] },
      },
    });
    await database.repositories.observations.retain({
      id: "observation-2",
      source: "whatsapp",
      accountId: "main",
      nativeId: "native-2",
      conversationId: "group-1@g.us",
      occurredAt: "2026-07-15T10:02:00.000Z",
      kind: "message",
      payload: {
        version: 1,
        messageId: "m-2",
        chatId: "group-1@g.us",
        sender: { id: "me@s.whatsapp.net", mode: "pn" },
        fromMe: true,
        timestamp: 1752573660000,
        historical: true,
        kind: "text",
        text: "noted, filing it",
        context: { quoted: { from: "reporter@lid", id: "m-1" } },
      },
    });
    await database.repositories.memoryJobs.create({
      conversationId: "group-1@g.us",
      observationIds: ["observation-1", "observation-2"],
    });

    const runner = service(
      database,
      agentWith(async (input) => {
        // Quoted-reply recovery attributed the first message; the reply threads.
        expect(input.messages[0]?.senderId).toBe("reporter@lid");
        expect(input.messages[0]?.mentions).toEqual(["androiddev@lid"]);
        expect(input.messages[1]?.inReplyTo).toBe("observation-1");
        return {
          entities: [
            // A mentioned id is linkable evidence even though it never "sent".
            {
              ref: "e1",
              kind: "person",
              canonicalName: "Android Dev",
              nativeIds: ["androiddev@lid"],
            },
          ],
          predicates: [{ ref: "p1", name: "works_on", description: "what they work on" }],
          claims: [
            {
              entity: "e1",
              predicate: "p1",
              value: "Android compass",
              confidence: "medium",
              evidenceObservationIds: ["observation-1"],
            },
          ],
          report: "One person recovered from mention evidence.",
        };
      }),
    );
    expect((await runner.runOnce()).outcome).toBe("done");
    expect(
      await database.repositories.memory.recall({
        nativeIds: ["androiddev@lid"],
        query: "",
        limit: 10,
      }),
    ).toHaveLength(1);
    expect(
      await database.repositories.memory.recallForConversation({
        conversationId: "group-1@g.us",
      }),
    ).toHaveLength(1);

    // A chat id can never become an identity, even when it appears as a sender.
    await database.repositories.memoryJobs.create({
      conversationId: "group-1@g.us",
      observationIds: ["observation-1", "observation-2"],
    });
    const poisoner = service(
      database,
      agentWith(async () => ({
        entities: [
          { ref: "e1", kind: "person", canonicalName: "Wrong", nativeIds: ["group-1@g.us"] },
        ],
        predicates: [],
        claims: [],
        report: "poison attempt",
      })),
    );
    expect((await poisoner.runOnce()).outcome).toBe("failed");
  });
});

test("a proposal citing evidence outside the batch fails the job without touching the ontology", async () => {
  await withDatabase(async (database) => {
    await retainHistory(database, "1", "a@s.whatsapp.net", "hello");
    await database.repositories.memoryJobs.create({
      conversationId: "group-1",
      observationIds: ["observation-1"],
    });

    const runner = service(
      database,
      agentWith(async () => ({
        ...goodProposal,
        entities: [goodProposal.entities[0]!],
        claims: [
          {
            entity: "e1",
            predicate: "p1",
            value: "x",
            confidence: "low",
            evidenceObservationIds: ["observation-999"],
          },
        ],
      })),
    );
    expect((await runner.runOnce()).outcome).toBe("failed");
    expect(
      await database.repositories.memory.recall({
        nativeIds: ["a@s.whatsapp.net"],
        query: "",
        limit: 10,
      }),
    ).toEqual([]);

    const evidence = await database.repositories.evaluationWork.claimNext({
      leaseOwner: "evals",
      leaseMs: 1_000,
    });
    if (evidence?.role !== "memory") throw new Error("expected memory evidence");
    expect(evidence.status).toBe("failed");
    expect(evidence.patchStatus).toBe("none");
    expect(evidence.error).toContain("cites evidence outside the batch");
  });
});

test("a restated fact reinforces and a changed fact supersedes — never a duplicate claim", async () => {
  await withDatabase(async (database) => {
    await retainHistory(database, "1", "a@s.whatsapp.net", "I run the Lavin project");
    await retainHistory(database, "2", "a@s.whatsapp.net", "Lavin is now called Lumen");
    const single: MemoryProposal = {
      ...goodProposal,
      entities: [goodProposal.entities[0]!],
      claims: [goodProposal.claims[0]!],
    };
    await database.repositories.memoryJobs.create({
      conversationId: "group-1",
      observationIds: ["observation-1"],
    });
    expect(
      (
        await service(
          database,
          agentWith(async () => single),
        ).runOnce()
      ).outcome,
    ).toBe("done");

    // A later window restates the same fact: the host reinforces instead of
    // violating the one-current-claim key.
    await database.repositories.memoryJobs.create({
      conversationId: "group-1",
      observationIds: ["observation-2"],
    });
    const restated: MemoryProposal = {
      ...single,
      claims: [{ ...single.claims[0]!, evidenceObservationIds: ["observation-2"] }],
    };
    expect(
      (
        await service(
          database,
          agentWith(async () => restated),
        ).runOnce()
      ).outcome,
    ).toBe("done");
    const afterRestate = await database.repositories.memory.recall({
      nativeIds: ["a@s.whatsapp.net"],
      query: "",
      limit: 10,
    });
    expect(afterRestate).toHaveLength(1);
    expect(afterRestate[0]?.evidenceObservationIds.toSorted()).toEqual([
      "observation-1",
      "observation-2",
    ]);

    // A later window changes the fact without declaring supersedes: the host
    // supersedes the current claim on its behalf.
    await database.repositories.memoryJobs.create({
      conversationId: "group-1",
      observationIds: ["observation-2"],
    });
    const changed: MemoryProposal = {
      ...single,
      claims: [{ ...single.claims[0]!, value: "Lumen", evidenceObservationIds: ["observation-2"] }],
    };
    expect(
      (
        await service(
          database,
          agentWith(async () => changed),
        ).runOnce()
      ).outcome,
    ).toBe("done");
    const afterChange = await database.repositories.memory.recall({
      nativeIds: ["a@s.whatsapp.net"],
      query: "",
      limit: 10,
    });
    expect(afterChange).toHaveLength(1);
    expect(afterChange[0]?.text).toContain("Lumen");
  });
});

test("an expired lease recovers without digesting the same job twice", async () => {
  await withDatabase(async (database) => {
    await retainHistory(database, "1", "a@s.whatsapp.net", "I run the Lavin project");
    const { jobId } = await database.repositories.memoryJobs.create({
      conversationId: "group-1",
      observationIds: ["observation-1"],
    });

    // A previous attempt claimed the job, applied its patch, and died before
    // completing.
    const abandoned = await database.repositories.memoryJobs.claimNext({
      leaseOwner: "crashed",
      leaseMs: 1_000,
      now: "2026-08-12T10:00:00.000Z",
    });
    expect(abandoned?.jobId).toBe(jobId);
    const run = await database.repositories.runs.start({
      agentId: "memory-analyst",
      role: "memory",
      conversationId: "group-1",
      model,
      promptVersion: "memory-v1",
      input: { jobId, conversationId: "group-1", observationIds: ["observation-1"] },
    });
    await database.repositories.memory.putEntity({
      id: "entity-1",
      kind: "person",
      canonicalName: "Aye",
    });
    await database.repositories.memory.linkIdentity({
      entityId: "entity-1",
      namespace: "whatsapp",
      nativeId: "a@s.whatsapp.net",
    });
    await database.repositories.memory.putPredicate({
      id: "predicate-1",
      name: "works_on",
      description: "what they work on",
      valueSchema: {},
    });
    await database.repositories.memory.applyPatch({
      id: `patch:${jobId}`,
      runId: run.id,
      source: { jobId },
      operations: [
        {
          operation: "create",
          claimId: "claim-1",
          entityId: "entity-1",
          predicateId: "predicate-1",
          value: "Lavin",
          confidence: "high",
          evidenceObservationIds: ["observation-1"],
        },
      ],
    });

    // While the lease holds, nobody else can claim.
    expect(
      await database.repositories.memoryJobs.claimNext({
        leaseOwner: "other",
        leaseMs: 1_000,
        now: "2026-08-12T10:00:00.500Z",
      }),
    ).toBeUndefined();

    const runner = service(
      database,
      agentWith(() => {
        throw new Error("a recovered job must not be digested again");
      }),
    );
    expect((await runner.runOnce("2026-08-12T10:00:02.000Z")).outcome).toBe("done");

    const recalled = await database.repositories.memory.recall({
      nativeIds: ["a@s.whatsapp.net"],
      query: "",
      limit: 10,
    });
    expect(recalled).toHaveLength(1);
  });
});
