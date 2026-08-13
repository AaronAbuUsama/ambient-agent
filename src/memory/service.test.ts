import { expect, test } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAmbientDatabase, type AmbientDatabase } from "../database/database";
import { createEvaluationService } from "../evals/service";
import type { MemoryRunEvidence } from "../evals/contract";
import type { MemoryAgent, MemoryInput, MemoryProposal } from "./contract";
import { createMemoryService, type MemoryServiceOptions } from "./service";

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

/** Memory is default-on for any chat with a speaker record; listening is enough. */
function allow(database: AmbientDatabase, conversationId: string): Promise<void> {
  return database.repositories.speakers.sync([{ conversationId, mode: "listening" }]);
}

async function retainHistory(
  database: AmbientDatabase,
  id: string,
  senderId: string,
  text: string,
  conversationId = "group-1",
): Promise<void> {
  await database.repositories.observations.retain({
    id: `observation-${id}`,
    source: "whatsapp",
    accountId: "main",
    nativeId: `native-${id}`,
    conversationId,
    occurredAt: `2026-07-15T10:0${id}:00.000Z`,
    kind: "message",
    payload: {
      version: 1,
      messageId: `m-${id}`,
      chatId: conversationId,
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

/** An agent that never proposes: memory silence. */
function silentAgent(): MemoryAgent {
  return {
    model,
    async run() {
      return { report: "Nothing worth remembering." };
    },
  };
}

function service(
  database: AmbientDatabase,
  agent: MemoryAgent,
  options?: Partial<MemoryServiceOptions>,
) {
  return createMemoryService({
    work: database.repositories.memoryWork,
    agent,
    ontology: database.repositories.memory,
    leaseOwner: "memory-test",
    ...options,
  });
}

test("a digest applies validated memory, recall returns it, and evals judge it", async () => {
  await withDatabase(async (database) => {
    await allow(database, "group-1");
    await retainHistory(database, "1", "a@s.whatsapp.net", "I run the Lavin project");
    await retainHistory(database, "2", "b@s.whatsapp.net", "The checkout button crashes");

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

    // The digested backlog is not claimable again.
    expect((await runner.runOnce()).outcome).toBe("idle");

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
    await allow(database, "group-1@g.us");
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
    await allow(database, "group-2@g.us");
    await retainHistory(database, "3", "c@s.whatsapp.net", "hello there", "group-2@g.us");
    const poisoner = service(
      database,
      agentWith(async () => ({
        entities: [
          { ref: "e1", kind: "person", canonicalName: "Wrong", nativeIds: ["group-2@g.us"] },
        ],
        predicates: [],
        claims: [],
        report: "poison attempt",
      })),
    );
    expect((await poisoner.runOnce()).outcome).toBe("failed");
  });
});

test("a proposal citing evidence outside the batch fails the window without touching the ontology", async () => {
  await withDatabase(async (database) => {
    await allow(database, "group-1");
    await retainHistory(database, "1", "a@s.whatsapp.net", "hello");

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

test("the sender's own name and second id form reach the analyst and link as one person", async () => {
  await withDatabase(async (database) => {
    await allow(database, "group-1");
    await database.repositories.observations.retain({
      id: "observation-1",
      source: "whatsapp",
      accountId: "main",
      nativeId: "native-1",
      conversationId: "group-1",
      occurredAt: "2026-07-15T10:01:00.000Z",
      kind: "message",
      payload: {
        version: 1,
        messageId: "m-1",
        chatId: "group-1",
        // One human, both id forms, publishing their own name.
        sender: { id: "a@s.whatsapp.net", mode: "pn", alt: "a@lid" },
        pushName: "Ada Lovelace",
        fromMe: false,
        timestamp: 1752573600000,
        text: "the compass page needs work",
      },
    });

    let seen: MemoryInput | undefined;
    const runner = service(
      database,
      agentWith(async (input) => {
        seen = input;
        return {
          // The alt form is linkable: the analyst may bind both to ONE person.
          entities: [
            {
              ref: "e1",
              kind: "person",
              canonicalName: "Ada Lovelace",
              nativeIds: ["a@s.whatsapp.net", "a@lid"],
            },
          ],
          predicates: [{ ref: "p1", name: "works_on", description: "what they work on" }],
          claims: [
            {
              entity: "e1",
              predicate: "p1",
              value: "Ada Lovelace works on the compass page",
              confidence: "high" as const,
              evidenceObservationIds: ["observation-1"],
            },
          ],
          report: "One person identified by their own published name.",
        };
      }),
    );
    expect((await runner.runOnce()).outcome).toBe("done");
    expect(seen?.messages[0]?.senderName).toBe("Ada Lovelace");
    expect(seen?.messages[0]?.senderAltId).toBe("a@lid");

    // Recall through EITHER id form returns the one person's claim.
    for (const nativeId of ["a@s.whatsapp.net", "a@lid"]) {
      expect(
        await database.repositories.memory.recall({ nativeIds: [nativeId], query: "", limit: 10 }),
      ).toHaveLength(1);
    }
  });
});

test("a claim value carrying a raw WhatsApp id or a bare symbol fails the window", async () => {
  await withDatabase(async (database) => {
    await allow(database, "group-1");
    await retainHistory(database, "1", "a@s.whatsapp.net", "the widget bug again");

    const claimWith = (value: unknown, evidenceId: string) => ({
      ...goodProposal,
      entities: [goodProposal.entities[0]!],
      claims: [
        {
          entity: "e1",
          predicate: "p1",
          value,
          confidence: "high" as const,
          evidenceObservationIds: [evidenceId],
        },
      ],
    });

    const idPoisoner = service(
      database,
      agentWith(async () => claimWith("reported by a@s.whatsapp.net", "observation-1")),
    );
    expect((await idPoisoner.runOnce()).outcome).toBe("failed");

    await allow(database, "group-3");
    await retainHistory(database, "3", "a@s.whatsapp.net", "one more", "group-3");
    const numberPoisoner = service(
      database,
      agentWith(async () => claimWith("Participant 447700900123", "observation-3")),
    );
    expect((await numberPoisoner.runOnce()).outcome).toBe("failed");

    await allow(database, "group-2");
    await retainHistory(database, "2", "a@s.whatsapp.net", "another report", "group-2");
    const symbolPoisoner = service(
      database,
      agentWith(async () => claimWith("E34", "observation-2")),
    );
    expect((await symbolPoisoner.runOnce()).outcome).toBe("failed");
    expect(
      await database.repositories.memory.recall({
        nativeIds: ["a@s.whatsapp.net"],
        query: "",
        limit: 10,
      }),
    ).toEqual([]);
  });
});

test("a restated fact reinforces and a changed fact supersedes — never a duplicate claim", async () => {
  await withDatabase(async (database) => {
    await allow(database, "group-1");
    const single: MemoryProposal = {
      ...goodProposal,
      entities: [goodProposal.entities[0]!],
      claims: [goodProposal.claims[0]!],
    };

    await retainHistory(database, "1", "a@s.whatsapp.net", "I run the Lavin project");
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
    await retainHistory(database, "2", "a@s.whatsapp.net", "Still running the Lavin project");
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
    await retainHistory(database, "3", "a@s.whatsapp.net", "Lavin is now called Lumen");
    const changed: MemoryProposal = {
      ...single,
      claims: [{ ...single.claims[0]!, value: "Lumen", evidenceObservationIds: ["observation-3"] }],
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

test("an expired lease recovers without digesting the same window twice", async () => {
  await withDatabase(async (database) => {
    await allow(database, "group-1");
    await retainHistory(database, "1", "a@s.whatsapp.net", "I run the Lavin project");

    // A previous attempt claimed the window, applied its patch, and died
    // before completing.
    const abandoned = await database.repositories.memoryWork.claimNext({
      leaseOwner: "crashed",
      leaseMs: 1_000,
      model,
      promptVersion: "memory-v3",
      window: 40,
      quietMs: 300_000,
      maximumAttempts: 3,
      now: "2026-08-12T10:00:00.000Z",
    });
    if (!abandoned) throw new Error("expected a claimable window");
    expect(abandoned.patchId).toBe("patch:window:observation-1");
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
      id: abandoned.patchId,
      runId: abandoned.runId,
      source: { window: abandoned.patchId },
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

    // While the lease holds, nobody else can claim the chat.
    expect(
      await database.repositories.memoryWork.claimNext({
        leaseOwner: "other",
        leaseMs: 1_000,
        model,
        promptVersion: "memory-v3",
        window: 40,
        quietMs: 300_000,
        maximumAttempts: 3,
        now: "2026-08-12T10:00:00.500Z",
      }),
    ).toBeUndefined();

    const runner = service(
      database,
      agentWith(() => {
        throw new Error("a recovered window must not be digested again");
      }),
    );
    expect((await runner.runOnce("2026-08-12T10:00:02.000Z")).outcome).toBe("done");

    const recalled = await database.repositories.memory.recall({
      nativeIds: ["a@s.whatsapp.net"],
      query: "",
      limit: 10,
    });
    expect(recalled).toHaveLength(1);
    // The watermark advanced; the recovered window is gone for good.
    expect((await runner.runOnce("2026-08-12T10:00:03.000Z")).outcome).toBe("idle");
  });
});

test("backlog coalesces until quiet, and a chat without a speaker record never digests", async () => {
  await withDatabase(async (database) => {
    await allow(database, "group-1");
    await retainHistory(database, "1", "a@s.whatsapp.net", "fresh message");
    // Same instant, different chat, no speaker record.
    await retainHistory(database, "2", "a@s.whatsapp.net", "unlisted chat", "stranger@g.us");

    const digested: number[] = [];
    const runner = service(
      database,
      agentWith(async (input) => {
        digested.push(input.messages.length);
        return { entities: [], predicates: [], claims: [], report: "noted" };
      }),
    );

    // One second after the message: still coalescing, nothing due.
    expect((await runner.runOnce("2026-07-15T10:01:01.000Z")).outcome).toBe("idle");
    // Six minutes of quiet: the tail is due, however small.
    expect((await runner.runOnce("2026-07-15T10:07:01.000Z")).outcome).toBe("done");
    expect(digested).toEqual([1]);
    // The unlisted chat's backlog is retained but never claimed.
    expect((await runner.runOnce("2026-07-15T11:00:00.000Z")).outcome).toBe("idle");
  });
});

test("a large backlog digests as ordered windows, each seeing what earlier windows built", async () => {
  await withDatabase(async (database) => {
    await allow(database, "group-1");
    for (const id of ["1", "2", "3", "4", "5"]) {
      await retainHistory(database, id, "a@s.whatsapp.net", `message ${id}`);
    }

    const batches: string[][] = [];
    const runner = service(
      database,
      agentWith(async (input) => {
        batches.push(input.messages.map(({ observationId }) => observationId));
        return { entities: [], predicates: [], claims: [], report: "noted" };
      }),
      { window: 2 },
    );
    expect((await runner.runOnce()).outcome).toBe("done");
    expect((await runner.runOnce()).outcome).toBe("done");
    expect((await runner.runOnce()).outcome).toBe("done");
    expect((await runner.runOnce()).outcome).toBe("idle");
    expect(batches).toEqual([
      ["observation-1", "observation-2"],
      ["observation-3", "observation-4"],
      ["observation-5"],
    ]);
  });
});

test("a window that keeps failing parks the chat instead of spending forever", async () => {
  await withDatabase(async (database) => {
    await allow(database, "group-1");
    await retainHistory(database, "1", "a@s.whatsapp.net", "hello");

    let attempts = 0;
    const runner = service(
      database,
      agentWith(async () => {
        attempts += 1;
        return {
          entities: [],
          predicates: [],
          claims: [
            {
              entity: "nonexistent",
              predicate: "nonexistent",
              value: "x",
              confidence: "low",
              evidenceObservationIds: ["observation-1"],
            },
          ],
          report: "always invalid",
        };
      }),
    );
    expect((await runner.runOnce()).outcome).toBe("failed");
    expect((await runner.runOnce()).outcome).toBe("failed");
    expect((await runner.runOnce()).outcome).toBe("failed");
    // Parked: the chat is no longer claimable, the backlog stays retained.
    expect((await runner.runOnce()).outcome).toBe("idle");
    expect(attempts).toBe(3);
  });
});

test("memory silence completes the window with an empty digest", async () => {
  await withDatabase(async (database) => {
    await allow(database, "group-1");
    await retainHistory(database, "1", "a@s.whatsapp.net", "ok");
    const runner = service(database, silentAgent());
    expect((await runner.runOnce()).outcome).toBe("done");
    expect((await runner.runOnce()).outcome).toBe("idle");
    expect(
      await database.repositories.memory.recallForConversation({ conversationId: "group-1" }),
    ).toEqual([]);
  });
});

test("the mandate's memory brief reaches the agent with every window", async () => {
  await withDatabase(async (database) => {
    await database.repositories.speakers.sync([
      {
        conversationId: "group-1",
        mode: "listening",
        memoryBrief: "Issues are the unit of memory.",
      },
    ]);
    await retainHistory(database, "1", "a@s.whatsapp.net", "the button crashes");

    const briefs: (string | undefined)[] = [];
    const runner = service(
      database,
      agentWith(async (input) => {
        briefs.push(input.brief);
        return { entities: [], predicates: [], claims: [], report: "noted" };
      }),
    );
    expect((await runner.runOnce()).outcome).toBe("done");
    expect(briefs).toEqual(["Issues are the unit of memory."]);
  });
});
