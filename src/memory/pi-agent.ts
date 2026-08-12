import { z } from "zod";
import { assistantText } from "../models/assistant-text";
import type { ModelRunner } from "../models/runtime";
import { extractJson } from "../models/structured-output";
import type { MemoryAgent, MemoryInput, MemoryProposal } from "./contract";

const systemPrompt = `You are Ambient's Memory Analyst.

You receive one bounded batch of retained WhatsApp messages from exactly one conversation, plus the
current ontology view (entities, predicates, current claims). Extract durable, evidence-backed
knowledge: who the participants are, what they work on, what issues they reported, stable
preferences and facts. Ephemeral chatter is not memory.

Respond with exactly one JSON object and nothing else:

{
  "entities": [{"ref": "e1", "kind": "person|project|product|organization|issue", "canonicalName": "...", "nativeIds": ["<sender id from the batch>"]}],
  "predicates": [{"ref": "p1", "name": "snake_case_name", "description": "..."}],
  "claims": [{"entity": "e1 or an existing entity id", "predicate": "p1 or an existing predicate id", "value": <json>, "confidence": "low|medium|high|confirmed", "evidenceObservationIds": ["..."], "supersedes": {"claimId": "...", "version": 1}}],
  "report": "one short paragraph on what you learned and skipped"
}

Rules:
- Reuse existing entities and predicates from the ontology view by their ids; create new ones only
  when nothing fits. nativeIds may only contain sender ids that appear in the batch.
- Every claim MUST cite evidenceObservationIds copied exactly from the batch messages that support
  it. A claim you cannot ground in specific messages must not be made.
- Use "supersedes" only to replace an existing claim from the view that new evidence contradicts,
  citing its exact claimId and version.
- confidence: "confirmed" only for facts stated directly by the person about themselves; "high" for
  clear repeated evidence; "medium" for single clear statements; "low" for inference.
- Prefer few strong claims over many weak ones.`;

const proposalSchema = z.object({
  entities: z
    .array(
      z.object({
        ref: z.string().min(1),
        kind: z.string().min(1),
        canonicalName: z.string().min(1),
        nativeIds: z.array(z.string().min(1)),
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

const promptVersion = "memory-v1";

export function createPiMemoryAgent(runner: ModelRunner): MemoryAgent & {
  readonly promptVersion: string;
} {
  return {
    model: runner.snapshot,
    promptVersion,
    async propose(input: MemoryInput): Promise<MemoryProposal> {
      const message = await runner
        .stream({
          systemPrompt,
          messages: [
            { role: "user", content: JSON.stringify(input, null, 2), timestamp: Date.now() },
          ],
        })
        .result();
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        throw new Error(message.errorMessage ?? `memory model ${message.stopReason}`);
      }
      return proposalSchema.parse(extractJson(assistantText(message)));
    },
  };
}
