import { z } from "zod";
import { assistantText } from "../models/assistant-text";
import type { ModelRunner } from "../models/runtime";
import { extractJson } from "../models/structured-output";
import type { MemoryAgent, MemoryInput, MemoryProposal } from "./contract";

const systemPrompt = `You are Ambient's Memory Analyst.

You receive one bounded batch of retained WhatsApp messages from exactly one conversation, plus the
current ontology view (entities, predicates, current claims). Extract durable, evidence-backed
knowledge into the ontology. This conversation is a working thread: people report bugs, request
features, file GitHub issues, and resolve problems over time.

Respond with exactly one JSON object and nothing else:

{
  "entities": [{"ref": "e1", "kind": "person|issue|repository|product|organization", "canonicalName": "...", "nativeIds": ["<sender or mentioned id from the batch>"]}],
  "predicates": [{"ref": "p1", "name": "snake_case_name", "description": "..."}],
  "claims": [{"entity": "e1 or an existing entity id like E2", "predicate": "p1 or an existing predicate id like P3", "value": <json>, "confidence": "low|medium|high|confirmed", "evidenceObservationIds": ["m4", "m17"], "supersedes": {"claimId": "C2", "version": 1}}],
  "report": "one short paragraph on what you learned and skipped"
}

Ids: batch messages are m1..mN; existing entities E1..EN, predicates P1..PN, claims C1..CN. Copy
them exactly; never invent ids outside these vocabularies.

Coverage — the prime rule:
- EVERY distinct bug, feature request, or question discussed becomes ONE "issue" entity with
  claims for what it is, which platform, its latest status (open, filed as owner/repo#n, fixed,
  disputed), and who reported or owns it. Do not skip small issues; an issue mentioned once is
  still memory. Missing an issue is worse than a modestly-worded claim.
- Also capture: people (role, GitHub username, what they own), repositories (URL, purpose, which
  issues went there), the product and its stable facts, and standing preferences or working rules
  people state (for example how issues should be filed or reviewed).
- Ephemeral chatter, greetings, and one-off test markers are NOT memory.
- Claim economy: cover everything, but merge related facts about one entity into one claim where
  natural — one issue gets one status claim (superseded as it evolves), not one claim per message.

Deduplication and evolution:
- Before creating an issue entity, check the ontology view: if an existing entity covers the same
  underlying problem, reuse its id and evolve its claims instead of duplicating it. The same bug
  reported twice on different days is ONE entity.
- When new evidence changes a fact (a bug gets fixed, a status changes, a root cause is found),
  use "supersedes" with the existing claim's exact claimId and version rather than adding a
  parallel contradictory claim.

Attribution honesty:
- Messages may lack senderId: historical sync lost the author. fromMe marks the agent's own
  account. Never invent who said something; attribute only what the evidence supports (content
  may still identify people by name).
- nativeIds may only contain ids that appear in the batch as a senderId or inside mentions.
  A chat/group id is NEVER a person's identity — never link it.
- Messages with "attachment" carry an image or video; the caption is its text. When a screenshot
  or video evidences an issue, cite that message like any other evidence.

Grounding:
- Every claim MUST cite evidenceObservationIds copied exactly from the batch messages that support
  it. A claim you cannot ground in specific messages must not be made.
- confidence: "confirmed" only for facts stated directly by the person about themselves; "high" for
  clear repeated evidence; "medium" for single clear statements; "low" for inference.`;

const proposalSchema = z.object({
  entities: z
    .array(
      z.object({
        ref: z.string().min(1),
        kind: z.string().min(1),
        canonicalName: z.string().min(1),
        // Issue/repo entities have no identities; models rightly omit the field.
        nativeIds: z.array(z.string().min(1)).default([]),
      }),
    )
    .default([]),
  predicates: z
    .array(
      z.object({
        ref: z.string().min(1),
        name: z.string().min(1),
        description: z.string().min(1),
      }),
    )
    .default([]),
  claims: z
    .array(
      z.object({
        entity: z.string().min(1),
        predicate: z.string().min(1),
        value: z.json(),
        confidence: z.enum(["low", "medium", "high", "confirmed"]),
        evidenceObservationIds: z.array(z.string().min(1)).min(1),
        supersedes: z
          .object({ claimId: z.string().min(1), version: z.number().int().positive() })
          .optional(),
      }),
    )
    .default([]),
  report: z.string().min(1),
});

const promptVersion = "memory-v2";

export function createPiMemoryAgent(runner: ModelRunner): MemoryAgent & {
  readonly promptVersion: string;
} {
  return {
    model: runner.snapshot,
    promptVersion,
    async propose(input: MemoryInput): Promise<MemoryProposal> {
      // The model never sees or copies real uuids: the adapter presents
      // compact symbols (m1/E1/P1/C1) and translates them back, so a
      // mistranscribed 36-character id can no longer invalidate a proposal.
      const messageSymbol = new Map(input.messages.map((m, i) => [`m${i + 1}`, m.observationId]));
      const entitySymbol = new Map(input.entities.map((e, i) => [`E${i + 1}`, e.id]));
      const predicateSymbol = new Map(input.predicates.map((p, i) => [`P${i + 1}`, p.id]));
      const claimSymbol = new Map(input.claims.map((c, i) => [`C${i + 1}`, c.claimId]));
      const symbolFor = (map: Map<string, string>, real: string): string =>
        [...map.entries()].find(([, value]) => value === real)?.[0] ?? real;
      const realFor = (map: Map<string, string>, symbol: string): string =>
        map.get(symbol) ?? symbol;

      const modelInput = {
        conversationId: input.conversationId,
        messages: input.messages.map((m, i) => ({
          ...m,
          observationId: `m${i + 1}`,
          ...(m.inReplyTo === undefined
            ? {}
            : { inReplyTo: symbolFor(messageSymbol, m.inReplyTo) }),
        })),
        entities: input.entities.map((e, i) => ({ ...e, id: `E${i + 1}` })),
        predicates: input.predicates.map((p, i) => ({ ...p, id: `P${i + 1}` })),
        claims: input.claims.map((c, i) => ({
          ...c,
          claimId: `C${i + 1}`,
          entityId: symbolFor(entitySymbol, c.entityId),
        })),
      };

      const message = await runner
        .stream({
          systemPrompt,
          messages: [
            { role: "user", content: JSON.stringify(modelInput, null, 2), timestamp: Date.now() },
          ],
        })
        .result();
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        throw new Error(message.errorMessage ?? `memory model ${message.stopReason}`);
      }
      const proposal = proposalSchema.parse(extractJson(assistantText(message)));
      return {
        ...proposal,
        claims: proposal.claims.map((claim) => ({
          ...claim,
          entity: realFor(entitySymbol, claim.entity),
          predicate: realFor(predicateSymbol, claim.predicate),
          evidenceObservationIds: claim.evidenceObservationIds.map((id) =>
            realFor(messageSymbol, id),
          ),
          ...(claim.supersedes === undefined
            ? {}
            : {
                supersedes: {
                  ...claim.supersedes,
                  claimId: realFor(claimSymbol, claim.supersedes.claimId),
                },
              }),
        })),
      };
    },
  };
}
