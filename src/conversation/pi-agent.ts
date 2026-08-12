import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  Type,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { ModelConfig } from "../agent-models";
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

function qwenProvider(modelId: string, environment: NodeJS.ProcessEnv) {
  const baseUrl =
    environment.QWEN_BASE_URL ?? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
  const model: Model<"openai-completions"> = {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: "qwen",
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262_144,
    maxTokens: 65_536,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
  };
  return createProvider({
    id: "qwen",
    name: "Qwen",
    baseUrl,
    auth: {
      apiKey: envApiKeyAuth("Qwen API key", ["QWEN_API_KEY", "DASHSCOPE_API_KEY"]),
    },
    models: [model],
    api: openAICompletionsApi(),
  });
}

function createModelCollection(
  config: ModelConfig,
  environment: NodeJS.ProcessEnv,
): { readonly models: Models; readonly model: Model<any> } {
  const models = config.provider === "qwen" ? createModels() : builtinModels();
  if (config.provider === "qwen") models.setProvider(qwenProvider(config.model, environment));
  const model = models.getModel(config.provider, config.model);
  if (!model) {
    throw new Error(`conversation model "${config.provider}/${config.model}" is not available`);
  }
  return { models, model };
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
  const text = message.content
    .flatMap((content) => (content.type === "text" ? [content.text] : []))
    .join("\n")
    .trim();
  return text || "Conversation run completed";
}

function sendMessageTool(tools: ConversationAgentTools): AgentTool {
  const parameters = Type.Object({
    text: Type.String({ minLength: 1, description: "The complete message to send." }),
  });
  let used = false;
  const tool: AgentTool<typeof parameters> = {
    name: "send_message",
    label: "Send message",
    description: "Send one WhatsApp text reply to this run's scoped destination.",
    parameters,
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
  const parameters = Type.Object({
    query: Type.String({ minLength: 1, description: "A concise memory search phrase." }),
  });
  const tool: AgentTool<typeof parameters> = {
    name: "recall",
    label: "Recall memory",
    description: "Recall evidence-backed facts scoped to this conversation and its participants.",
    parameters,
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

export function createPiConversationAgent(
  options: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly resolveModel?: (config: ModelConfig) => {
      readonly models: Models;
      readonly model: Model<any>;
    };
  } = {},
): ConversationAgent {
  const environment = options.environment ?? process.env;
  return {
    async run(modelConfig, input, tools, signal): Promise<ConversationResult> {
      const { models, model } =
        options.resolveModel?.(modelConfig) ?? createModelCollection(modelConfig, environment);
      const agent = new Agent({
        initialState: {
          systemPrompt,
          model,
          thinkingLevel: modelConfig.thinking,
          tools: [recallTool(tools), sendMessageTool(tools)],
        },
        streamFn: (activeModel, context, streamOptions) =>
          models.streamSimple(activeModel, context, {
            ...streamOptions,
            maxTokens: modelConfig.maxOutputTokens,
          }),
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
