import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "@earendil-works/pi-ai";
import { assistantText } from "../models/assistant-text";
import type { ModelRunner } from "../models/runtime";
import type { MemoryAgent, MemoryInput, MemoryProposal, MemoryTools } from "./contract";

const basePrompt = `You are Ambient's Memory Analyst.

You receive one bounded batch of retained WhatsApp messages from exactly one conversation, plus the
current ontology view (entities, predicates, current claims). Extract durable, evidence-backed
knowledge into the ontology.

Call the propose_facts tool ONCE with everything worth remembering from this batch. If the tool
rejects your proposal, correct the problem it names and call it again. If nothing in the batch is
worth remembering, do not call the tool; briefly report why. After the tool succeeds, reply with a
one-paragraph report on what you learned and skipped.

Ids: batch messages are m1..mN; existing entities E1..EN, predicates P1..PN, claims C1..CN. Copy
them exactly; never invent ids outside these vocabularies.

Coverage:
- Capture the people in the conversation (roles, identities, what they own and work on), the
  stable facts of whatever this chat is about, decisions and commitments people make, and the
  standing preferences or working rules people state.
- A person NAMED in a message is memory: create the person entity under that name and claim what
  the messages say about them. Greetings, mentions, signatures, and being addressed by name all
  name a person. Refusing to attribute an unsigned message (below) is never a reason to leave a
  named person out of the ontology.
- EVERY entity you create must carry at least one claim of its own, and that claim's value must
  name it. Recall returns claims, never bare entities: a person nobody has claimed anything about
  is invisible to Ambient, so state who they are — their name, and their role, work, or part in
  this thread as the messages show it.
- When a digestion brief for this chat is provided below, its focus is the prime coverage rule.
- Ephemeral chatter, greetings, and one-off test markers are NOT memory. Automated proof and
  test traffic is the trap here: instructions to "create a test issue", scripted start tokens,
  and a bot's acknowledgements of them mention issues and repositories, but they record no
  product knowledge. A thing whose entire existence is a test of the machinery is not an issue —
  skip it, however much it resembles the work the brief asks for.
- Claim economy: cover everything that matters, but merge related facts about one entity into one
  claim where natural — one evolving fact gets one claim, superseded as it changes, not one claim
  per message.

Deduplication and evolution:
- Before creating an entity, check the ontology view: if an existing entity covers the same
  underlying thing, reuse its id and evolve its claims instead of duplicating it. The same thing
  mentioned twice on different days is ONE entity.
- When new evidence changes a fact, use "supersedes" with the existing claim's exact claimId and
  version rather than adding a parallel contradictory claim.

Attribution honesty:
- Messages may lack senderId: historical sync lost the author. fromMe marks the agent's own
  account. Never invent who said something; attribute only what the evidence supports (content
  may still identify people by name).
- An attribution claim (reported_by and the like) stands only when its OWN cited messages show
  the author — a senderId, or the person named in the content. When the cited messages carry no
  author, drop the attribution claim entirely rather than inferring it from other windows.
  A subscriber number is not a name: never write "Participant 4477…" as a person.
- nativeIds may only contain ids that appear in the batch as a senderId or inside mentions.
  A chat/group id is NEVER a person's identity — never link it.
- Messages with "attachment" carry an image or video; the caption is its text. When a screenshot
  or video evidences an issue, cite that message like any other evidence.

Grounding:
- Every claim MUST cite evidenceObservationIds copied exactly from the batch messages that support
  it — including the neighbouring messages that give a terse statement its subject. A claim is
  judged against ONLY its cited messages; if they alone do not state or clearly imply it, cite
  more of the batch or do not make the claim.
- Claim values are content in words: name people and things by their names, never by id symbol
  (E1), subscriber number, or raw WhatsApp id.
- A claim value is a short, flat statement of the fact itself. Do NOT narrate the digestion
  ("open or unfiled in this batch", "no decision recorded here"), do NOT reason inside the value
  ("implying the fault is..."), and do NOT assert a status no cited message states — an issue
  nobody has resolved is simply "open".
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

const promptVersion = "memory-v8";

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

  const entityName = new Map(input.entities.map((e, i) => [`E${i + 1}`, e.canonicalName]));

  const desymbolize = (proposal: Static<typeof proposeFactsParameters>): MemoryProposal => {
    // The model may reference an entity inside a claim VALUE ("reported_by":
    // "E3" or a ref it proposed this call). Symbols are run-local, so a stored
    // symbol dangles forever — translate bare symbol values to the entity's
    // canonical name at the same boundary that translates every other id.
    const proposedName = new Map(proposal.entities.map((e) => [e.ref, e.canonicalName]));
    const contentValue = (value: unknown): unknown =>
      typeof value === "string"
        ? (entityName.get(value) ?? proposedName.get(value) ?? value)
        : value;
    return {
      ...proposal,
      claims: proposal.claims.map((claim) => ({
        ...claim,
        entity: realFor(entitySymbol, claim.entity),
        predicate: realFor(predicateSymbol, claim.predicate),
        value: contentValue(claim.value),
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
  };

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
      const systemPrompt = input.brief
        ? `${basePrompt}\n\nDigestion brief for this chat — the prime coverage rule:\n${input.brief}`
        : basePrompt;
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
