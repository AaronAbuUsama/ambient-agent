import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { assistantText } from "../models/assistant-text";
import type { ModelRunner } from "../models/runtime";
import type {
  ConversationAgent,
  ConversationAgentTools,
  ConversationInput,
  ConversationResult,
} from "./contract";

const systemPrompt = `You are Ambient's Conversation Agent.

You receive a bounded durable batch of new WhatsApp messages for exactly one conversation.
Use recall when retained facts would materially improve the answer. Decide whether the user needs a
response. To reply, call send_message exactly once with the full message. To remain silent, do not
call it. Never claim you sent a message unless the tool succeeds. After acting or choosing silence,
return a short internal summary of the decision.`;

/** The settled prompt layers: fixed identity, then the chat's granted skills. */
function composeSystemPrompt(input: ConversationInput): string {
  if (input.skills.length === 0) return systemPrompt;
  const sections = input.skills
    .map((skill) => `## Skill: ${skill.name}\n\n${skill.content}`)
    .join("\n\n");
  return `${systemPrompt}\n\nApply these granted skills where they fit:\n\n${sections}`;
}

function prompt(input: ConversationInput): string {
  return JSON.stringify(
    {
      conversationId: input.conversationId,
      instructions: input.instructions,
      newMessages: input.newMessages,
    },
    null,
    2,
  );
}

function lastAssistantText(agent: Agent): string {
  const message = [...agent.state.messages].reverse().find(({ role }) => role === "assistant");
  if (!message || message.role !== "assistant") return "Conversation run completed";
  return assistantText(message) || "Conversation run completed";
}

const sendMessageParameters = Type.Object({
  text: Type.String({ minLength: 1, description: "The complete message to send." }),
});

const recallParameters = Type.Object({
  query: Type.String({ minLength: 1, description: "A concise memory search phrase." }),
});

function sendMessageTool(tools: ConversationAgentTools): AgentTool {
  let used = false;
  const tool: AgentTool<typeof sendMessageParameters> = {
    name: "send_message",
    label: "Send message",
    description: "Send one WhatsApp text reply to this run's scoped destination.",
    parameters: sendMessageParameters,
    executionMode: "sequential",
    async execute(toolCallId, { text }) {
      if (used) throw new Error("send_message can only be called once per Conversation run");
      used = true;
      const result = await tools.sendMessage(text, toolCallId);
      return {
        content: [{ type: "text", text: `Message queued as operation ${result.operationId}.` }],
        details: result,
      };
    },
  };
  return tool;
}

function recallTool(tools: ConversationAgentTools): AgentTool {
  const tool: AgentTool<typeof recallParameters> = {
    name: "recall",
    label: "Recall memory",
    description: "Recall evidence-backed facts scoped to this conversation and its participants.",
    parameters: recallParameters,
    async execute(toolCallId, { query }) {
      const result = await tools.recall(query, toolCallId);
      return {
        content: [{ type: "text", text: JSON.stringify(result.claims) }],
        details: result,
      };
    },
  };
  return tool;
}

export function createPiConversationAgent(runner: ModelRunner): ConversationAgent {
  return {
    model: runner.snapshot,
    async run(input, tools, signal): Promise<ConversationResult> {
      const agent = new Agent({
        initialState: {
          systemPrompt: composeSystemPrompt(input),
          model: runner.model,
          thinkingLevel: runner.thinkingLevel,
          tools: [recallTool(tools), sendMessageTool(tools)],
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
