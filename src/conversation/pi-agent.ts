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

Consult what you already know before asking anyone anything. recall returns evidence-backed facts
about this conversation and its people, and an empty query returns everything you hold here — use
that when you are asked what you know, or how many of something are still open. search_history
re-reads the retained messages themselves, captions included, when you need the original wording
rather than a settled fact. Ask a person only for what neither can tell you.

A message may carry an attachment. Its caption stands in as the text, and a description is present
once the image has been interpreted. For an older image that has none — one search_history turned
up, say — call view_image with its ref to look at it. Never describe an image you have no
description of, and never imply you watched a video: say plainly that you cannot see it and ask
what it shows.

Decide whether the user needs a response. To reply, call send_message exactly once with the full
message. To remain silent, do not call it. Never claim you sent a message unless the tool succeeds.
After acting or choosing silence, return a short internal summary of the decision.`;

/** The settled prompt layers: fixed identity, the chat's skills, its granted agents. */
function composeSystemPrompt(input: ConversationInput): string {
  const sections: string[] = [systemPrompt];
  if (input.skills.length > 0) {
    const skills = input.skills
      .map((skill) => `## Skill: ${skill.name}\n\n${skill.content}`)
      .join("\n\n");
    sections.push(`Apply these granted skills where they fit:\n\n${skills}`);
  }
  const agents = input.agents ?? [];
  if (agents.length > 0) {
    const list = agents
      .map((agent) => `- ${agent.name}: ${agent.summary.split("\n").join(" — ")}`)
      .join("\n");
    sections.push(
      `You can delegate bounded background tasks to these agents:\n${list}\n` +
        `Call delegate with the agent's name, a complete self-contained objective, and — when the ` +
        `agent lists more than one destination — the one target to use. The task runs after this ` +
        `turn; its result arrives as a later task update. Delegate at most once per run, and tell ` +
        `the chat what you set in motion. When a task update arrives in your input, report its ` +
        `outcome concisely (numbers, links) — or its failure honestly.`,
    );
  }
  return sections.join("\n\n");
}

function prompt(input: ConversationInput): string {
  const taskUpdates = input.taskUpdates ?? [];
  return JSON.stringify(
    {
      conversationId: input.conversationId,
      instructions: input.instructions,
      newMessages: input.newMessages,
      ...(taskUpdates.length > 0 ? { taskUpdates } : {}),
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
  query: Type.String({
    description:
      "A concise memory search phrase. Pass an empty string to see everything " +
      "known about this conversation, including every issue it has discussed.",
  }),
});

const searchHistoryParameters = Type.Object({
  query: Type.String({ minLength: 1, description: "Words to look for in past messages." }),
});

const viewImageParameters = Type.Object({
  ref: Type.String({
    minLength: 1,
    description: "The attachment ref of an image in this conversation.",
  }),
});

const delegateParameters = Type.Object({
  agent: Type.String({
    minLength: 1,
    description: "The name of a granted agent from your delegation list.",
  }),
  objective: Type.String({
    minLength: 1,
    description: "A complete, self-contained objective the agent can act on alone.",
  }),
  target: Type.Optional(
    Type.String({
      minLength: 1,
      description: "The destination to use when the agent lists more than one.",
    }),
  ),
  attachments: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      description:
        "Attachment refs from this conversation to carry as evidence, such as the " +
        "screenshot that shows the problem.",
    }),
  ),
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

function searchHistoryTool(tools: ConversationAgentTools): AgentTool {
  const tool: AgentTool<typeof searchHistoryParameters> = {
    name: "search_history",
    label: "Search history",
    description:
      "Search this conversation's retained messages, including image and video captions.",
    parameters: searchHistoryParameters,
    async execute(toolCallId, { query }) {
      const result = await tools.searchHistory(query, toolCallId);
      return {
        content: [{ type: "text", text: JSON.stringify(result.messages) }],
        details: result,
      };
    },
  };
  return tool;
}

function viewImageTool(tools: ConversationAgentTools): AgentTool {
  const tool: AgentTool<typeof viewImageParameters> = {
    name: "view_image",
    label: "View image",
    description:
      "Look at one image from this conversation — use it when an attachment has no description.",
    parameters: viewImageParameters,
    async execute(toolCallId, { ref }) {
      const result = await tools.viewImage(ref, toolCallId);
      return {
        content: [
          {
            type: "text",
            text:
              result.description ?? `Cannot view it: ${result.unavailable ?? "unknown reason"}.`,
          },
        ],
        details: result,
      };
    },
  };
  return tool;
}

function delegateTool(tools: ConversationAgentTools): AgentTool {
  const tool: AgentTool<typeof delegateParameters> = {
    name: "delegate",
    label: "Delegate task",
    description: "Open one bounded background assignment for a granted agent.",
    parameters: delegateParameters,
    executionMode: "sequential",
    async execute(toolCallId, { agent, objective, target, attachments }) {
      const opened = await tools.delegate({ agent, objective, target, attachments }, toolCallId);
      const verb = opened.outcome === "adopted" ? "already open as" : "opened as";
      return {
        content: [{ type: "text", text: `Assignment ${verb} task ${opened.taskId}.` }],
        details: opened,
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
          tools: [
            recallTool(tools),
            searchHistoryTool(tools),
            viewImageTool(tools),
            sendMessageTool(tools),
            ...((input.agents ?? []).length > 0 ? [delegateTool(tools)] : []),
          ],
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
