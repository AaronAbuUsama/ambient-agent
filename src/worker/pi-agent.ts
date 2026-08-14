import { Agent } from "@earendil-works/pi-agent-core";
import { assistantText } from "../models/assistant-text";
import type { ModelRunner } from "../models/runtime";
import type { WorkerAgent, WorkerInput } from "./contract";

const PROMPT_VERSION = "worker-v1";

const systemPrompt = `You are Ambient's Worker Agent.

You receive ONE bounded objective delegated from a conversation. Complete it with your tools, then
finish. Rules:
- An external effect exists only when its tool call succeeds. Never claim an effect the tool did
  not confirm.
- Stay strictly inside the objective. One assignment is one bounded piece of work — no follow-up
  work, no side quests.
- When the objective is done, or genuinely impossible, reply with a short factual summary: what
  happened, the identifiers of any effects (issue numbers, URLs), or exactly why it could not be
  done.`;

/** The settled prompt layers: role craft, then the definition's specialty. */
function composeSystemPrompt(input: WorkerInput): string {
  return `${systemPrompt}\n\n## Your specialty\n\n${input.definition.instructions}`;
}

function prompt(input: WorkerInput): string {
  return JSON.stringify(
    {
      objective: input.objective,
      ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
    },
    null,
    2,
  );
}

function lastAssistantText(agent: Agent): string {
  const message = [...agent.state.messages].reverse().find(({ role }) => role === "assistant");
  if (!message || message.role !== "assistant") return "Worker run completed";
  return assistantText(message) || "Worker run completed";
}

export function createPiWorkerAgent(runner: ModelRunner): WorkerAgent {
  return {
    model: runner.snapshot,
    promptVersion: PROMPT_VERSION,
    async run(input, tools, signal) {
      const agent = new Agent({
        initialState: {
          systemPrompt: composeSystemPrompt(input),
          model: runner.model,
          thinkingLevel: runner.thinkingLevel,
          tools: [...tools],
        },
        streamFn: (_model, context, streamOptions) => runner.stream(context, streamOptions),
        toolExecution: "sequential",
      });
      const abort = () => agent.abort();
      signal?.addEventListener("abort", abort, { once: true });
      try {
        await agent.prompt(prompt(input));
      } finally {
        signal?.removeEventListener("abort", abort);
      }
      if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
      return { summary: lastAssistantText(agent) };
    },
  };
}
