import { defineAgent, type AgentRouteHandler } from "@flue/runtime";

import graphExtraction from "../capabilities/graph-extraction/SKILL.md" with { type: "skill" };
import { createGraphTools } from "../capabilities/graph/tools.ts";
import { resolveAgentModelProfile } from "@ambient-agent/engine/model/pi-subscription.ts";
import { acceptsScribeDirectToken } from "./direct-access.ts";

/** Private loopback SDK seam used by the Historical Replay workflow. */
export const route: AgentRouteHandler = async (context, next) => {
  if (!acceptsScribeDirectToken(context.req.header("authorization"))) return context.notFound();
  await next();
};

export const description =
  "One fresh, silent Scribe attempt that proposes shared ontology from a bounded cross-Surface batch; it never speaks or owns memory.";

// Its own model + thinkingLevel on the one shared credential: starts cheap and
// minimal-thinking, latency-free, so it can go heavier if extraction quality demands.
// Only the four ontology tools — no Say, no whatsapp-participation, no issue-management.
export default defineAgent(() => ({
  ...resolveAgentModelProfile("scribe"),
  skills: [graphExtraction],
  tools: createGraphTools(),
  instructions: [
    "You are one stateless attempt of the coworker's single global Scribe ingestion clock.",
    "You never reply, retain authority, or rely on prior private turns; your only effects are the four graph tools.",
    "Each turn is one bounded cross-Surface Scribe Batch with a stable batchId and trusted immutable evidenceIds.",
    "Read all inputs together in their supplied chronology, including relationships that only become visible across chats.",
    "Extract the ontology from them per the graph-extraction skill.",
    "Use only supplied evidenceIds for provenance; never invent a source reference.",
    "Record honestly, not certainly: when unsure, propose a low-confidence fact rather than nothing.",
  ].join("\n"),
}));
