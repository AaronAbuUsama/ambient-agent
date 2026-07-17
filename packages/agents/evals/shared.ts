import { expect } from "vitest";

import type { FlueAgentEvalOutput } from "../../test-support/src/evals/harness.ts";

/** A single-sender Window rendered the way the coalescer presents it to the agent. */
export const windowMessage = (text: string): string =>
  `WhatsApp Window for the current managed chat:\nAlice: ${text}`;

/** The agent did nothing observable: no WhatsApp events, no GitHub events or operations. */
export const expectNoExternalEffects = (output: FlueAgentEvalOutput): void => {
  expect(output.whatsappEvents).toEqual([]);
  expect(output.githubEvents).toEqual([]);
  expect(output.githubOperations).toEqual([]);
};

export const githubEventKinds = (output: FlueAgentEvalOutput): readonly (string | undefined)[] =>
  output.githubEvents.map((event) => (event as { kind?: string }).kind);
