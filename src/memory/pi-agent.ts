import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "@earendil-works/pi-ai";
import { assistantText } from "../models/assistant-text";
import type { ModelRunner } from "../models/runtime";
import type { MemoryAgent, MemoryInput, MemoryProposal, MemoryTools } from "./contract";

const systemPrompt = `You are Ambient's Memory Analyst.

You receive one bounded batch of retained WhatsApp messages from exactly one conversation, plus the
current ontology view (entities, predicates, current claims). Extract durable, evidence-backed
knowledge into the ontology. This conversation is a working thread: people report bugs, request
features, file GitHub issues, and resolve problems over time.

Call the propose_facts tool ONCE with everything worth remembering from this batch. If the tool
rejects your proposal, correct the problem it names and call it again. If nothing in the batch is
worth remembering, do not call the tool; briefly report why. After the tool succeeds, reply with a
one-paragraph report on what you learned and skipped.

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

const confidence = Type.Union([
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("confirmed"),
]);

const proposeFactsParameters = Type.Object({
  entities: Type.Array(
    Type.Object({
      ref: Type.String({ minLength: 1 }),
      kind: Type.String({
        minLength: 1,
        description: "person | issue | repository | product | organization",
      }),
      canonicalName: Type.String({ minLength: 1 }),
      nativeIds: Type.Array(Type.String({ minLength: 1 }), {
        default: [],
        description: "Sender or mentioned ids from the batch; never a chat id.",
      }),
    }),
    { default: [] },
  ),
  predicates: Type.Array(
    Type.Object({
      ref: Type.String({ minLength: 1 }),
      name: Type.String({ minLength: 1, description: "snake_case_name" }),
      description: Type.String({ minLength: 1 }),
    }),
    { default: [] },
  ),
  claims: Type.Array(
    Type.Object({
      entity: Type.String({
        minLength: 1,
        description: "A proposed ref like e1, or an existing entity id like E2.",
      }),
      predicate: Type.String({ minLength: 1 }),
      value: Type.Unknown(),
      confidence,
      evidenceObservationIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
      supersedes: Type.Optional(
        Type.Object({
          claimId: Type.String({ minLength: 1 }),
          version: Type.Integer({ minimum: 1 }),
        }),
      ),
    }),
    { default: [] },
  ),
  report: Type.String({
    minLength: 1,
    description: "One short paragraph on what you learned and skipped.",
  }),
});

const promptVersion = "memory-v3";

function lastAssistantText(agent: Agent): string {
  const message = [...agent.state.messages].reverse().find(({ role }) => role === "assistant");
  if (!message || message.role !== "assistant") return "Memory run completed";
  return assistantText(message) || "Memory run completed";
}

/**
 * The model never sees or copies real uuids: this adapter presents compact
 * symbols (m1/E1/P1/C1) and translates them back at the tool boundary, so a
 * mistranscribed 36-character id can never invalidate a proposal.
 */
function symbolize(input: MemoryInput) {
  const messageSymbol = new Map(input.messages.map((m, i) => [`m${i + 1}`, m.observationId]));
  const entitySymbol = new Map(input.entities.map((e, i) => [`E${i + 1}`, e.id]));
  const predicateSymbol = new Map(input.predicates.map((p, i) => [`P${i + 1}`, p.id]));
  const claimSymbol = new Map(input.claims.map((c, i) => [`C${i + 1}`, c.claimId]));
  const symbolFor = (map: Map<string, string>, real: string): string =>
    [...map.entries()].find(([, value]) => value === real)?.[0] ?? real;
  const realFor = (map: Map<string, string>, symbol: string): string => map.get(symbol) ?? symbol;

  const modelInput = {
    conversationId: input.conversationId,
    messages: input.messages.map((m, i) => ({
      ...m,
      observationId: `m${i + 1}`,
      ...(m.inReplyTo === undefined ? {} : { inReplyTo: symbolFor(messageSymbol, m.inReplyTo) }),
    })),
    entities: input.entities.map((e, i) => ({ ...e, id: `E${i + 1}` })),
    predicates: input.predicates.map((p, i) => ({ ...p, id: `P${i + 1}` })),
    claims: input.claims.map((c, i) => ({
      ...c,
      claimId: `C${i + 1}`,
      entityId: symbolFor(entitySymbol, c.entityId),
    })),
  };

  const desymbolize = (proposal: Static<typeof proposeFactsParameters>): MemoryProposal => ({
    ...proposal,
    claims: proposal.claims.map((claim) => ({
      ...claim,
      entity: realFor(entitySymbol, claim.entity),
      predicate: realFor(predicateSymbol, claim.predicate),
      evidenceObservationIds: claim.evidenceObservationIds.map((id) => realFor(messageSymbol, id)),
      ...(claim.supersedes === undefined
        ? {}
        : {
            supersedes: {
              ...claim.supersedes,
              claimId: realFor(claimSymbol, claim.supersedes.claimId),
            },
          }),
    })),
  });

  return { modelInput, desymbolize };
}

function proposeFactsTool(
  tools: MemoryTools,
  desymbolize: (proposal: Static<typeof proposeFactsParameters>) => MemoryProposal,
): AgentTool {
  const tool: AgentTool<typeof proposeFactsParameters> = {
    name: "propose_facts",
    label: "Propose facts",
    description:
      "Propose evidence-backed entities, predicates, and claims from this batch. The host " +
      "validates and applies them; an invalid proposal is rejected with the reason.",
    parameters: proposeFactsParameters,
    executionMode: "sequential",
    async execute(toolCallId, proposal) {
      const applied = await tools.proposeFacts(desymbolize(proposal), toolCallId);
      return {
        content: [
          {
            type: "text",
            text:
              `Applied: ${applied.claims.length} claims, ${applied.entitiesCreated} new entities, ` +
              `patch ${applied.patchStatus}.`,
          },
        ],
        details: applied,
      };
    },
  };
  return tool;
}

export function createPiMemoryAgent(runner: ModelRunner): MemoryAgent & {
  readonly promptVersion: string;
} {
  return {
    model: runner.snapshot,
    promptVersion,
    async run(input, tools, signal) {
      const { modelInput, desymbolize } = symbolize(input);
      const agent = new Agent({
        initialState: {
          systemPrompt,
          model: runner.model,
          thinkingLevel: runner.thinkingLevel,
          tools: [proposeFactsTool(tools, desymbolize)],
        },
        streamFn: (_model, context, streamOptions) => runner.stream(context, streamOptions),
        toolExecution: "sequential",
      });
      const abort = () => agent.abort();
      signal?.addEventListener("abort", abort, { once: true });
      try {
        await agent.prompt(JSON.stringify(modelInput, null, 2));
      } finally {
        signal?.removeEventListener("abort", abort);
      }
      if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
      return { report: lastAssistantText(agent) };
    },
  };
}
