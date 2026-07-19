import { defineAgent, type AgentRouteHandler } from "@flue/runtime";

import graphExtraction from "../capabilities/graph-extraction/SKILL.md" with { type: "skill" };
import { createGraphTools } from "../capabilities/graph/tools.ts";
import { resolveAgentModelProfile } from "@ambient-agent/engine/model/pi-subscription.ts";
import { acceptsScribeDirectToken } from "./direct-access.ts";

/** Private loopback SDK seam used by the durable backfill workflow. */
export const route: AgentRouteHandler = async (context, next) => {
  if (!acceptsScribeDirectToken(context.req.header("authorization"))) return context.notFound();
  await next();
};

export const description =
  "A silent per-thread agent that extracts the shared graph ontology from a chat's inputs; it never speaks and has no external identity.";

// Its own model + thinkingLevel on the one shared credential: starts cheap and
// minimal-thinking, latency-free, so it can go heavier if extraction quality demands.
// Only the four ontology tools — no Say, no whatsapp-participation, no issue-management.
export default defineAgent(() => ({
  ...resolveAgentModelProfile("scribe"),
  skills: [graphExtraction],
  tools: createGraphTools(),
  instructions: [
    "You are Scribe, the silent writer for one WhatsApp chat's slice of the shared graph.",
    "You never reply and have no GitHub identity; your only effects are the four graph tools.",
    "Each turn is a batch of the chat's recent inputs (WhatsApp windows, GitHub events, finished-job results).",
    "Extract the ontology from them per the graph-extraction skill.",
    "Record honestly, not certainly: when unsure, write a low-confidence fact rather than nothing.",
  ].join("\n"),
}));
