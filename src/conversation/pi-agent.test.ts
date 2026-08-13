import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { expect, test } from "vite-plus/test";
import type { ModelRunner } from "../models/runtime";
import { createPiConversationAgent } from "./pi-agent";

function fauxRunner(faux: ReturnType<typeof fauxProvider>, maxOutputTokens = 1024): ModelRunner {
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel()!;
  return {
    snapshot: { provider: "faux", model: model.id, thinking: "off", maxOutputTokens },
    model,
    thinkingLevel: "off",
    stream: (context, options) =>
      models.streamSimple(model, context, { ...options, maxTokens: maxOutputTokens }),
  };
}

const input = {
  conversationId: "chat-1",
  instructions: "Be concise.",
  skills: [],
  newMessages: [
    {
      observationId: "observation-1",
      whatsappMessageId: "message-1",
      senderId: "person@s.whatsapp.net",
      sentAt: "2026-08-11T10:00:00.000Z",
      text: "hello",
      fromAgent: false,
    },
  ],
};

test("Pi Conversation calls the scoped send tool and returns an internal summary", async () => {
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("recall", { query: "preferred greeting" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage([fauxToolCall("send_message", { text: "hello back" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage([fauxText("Replied to the greeting.")]),
  ]);
  const sends: string[] = [];
  const recalls: string[] = [];
  const agent = createPiConversationAgent(fauxRunner(faux));

  const result = await agent.run(input, {
    async sendMessage(text) {
      sends.push(text);
      return { operationId: "operation-1" };
    },
    async recall(query) {
      recalls.push(query);
      return {
        claims: [
          {
            claimId: "claim-1",
            text: "Person preferred greeting: warm",
            confidence: "high",
            evidenceObservationIds: ["observation-0"],
          },
        ],
      };
    },
  });

  expect(sends).toEqual(["hello back"]);
  expect(recalls).toEqual(["preferred greeting"]);
  expect(result).toEqual({ summary: "Replied to the greeting." });
  expect(faux.state.callCount).toBe(3);
});

test("Pi Conversation can deliberately finish without sending", async () => {
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage([fauxText("Silence was appropriate.")])]);
  const agent = createPiConversationAgent(fauxRunner(faux));

  const result = await agent.run(input, {
    async sendMessage() {
      throw new Error("send_message must not be called");
    },
    async recall() {
      return { claims: [] };
    },
  });

  expect(result).toEqual({ summary: "Silence was appropriate." });
  expect(faux.state.callCount).toBe(1);
});

test("Pi Conversation forwards output limits and propagates provider errors", async () => {
  const faux = fauxProvider();
  let maxTokens: number | undefined;
  faux.setResponses([
    (_context, options) => {
      maxTokens = options?.maxTokens;
      return fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "provider unavailable",
      });
    },
  ]);
  const agent = createPiConversationAgent(fauxRunner(faux, 321));

  await expect(
    agent.run(input, {
      async sendMessage() {
        throw new Error("send_message must not be called");
      },
      async recall() {
        return { claims: [] };
      },
    }),
  ).rejects.toThrow("provider unavailable");
  expect(maxTokens).toBe(321);
});

test("granted skills are appended to the system prompt, none means the base prompt", async () => {
  const faux = fauxProvider();
  const prompts: string[] = [];
  const respond = (context: { systemPrompt?: string }) => {
    prompts.push(context.systemPrompt ?? "");
    return fauxAssistantMessage([fauxText("noted")], { stopReason: "stop" });
  };
  faux.setResponses([respond, respond]);
  const agent = createPiConversationAgent(fauxRunner(faux));
  const tools = {
    async sendMessage() {
      return { operationId: "op-1" };
    },
    async recall() {
      return { claims: [] };
    },
  };

  await agent.run(
    {
      ...input,
      skills: [{ name: "triage", content: "End every reply with the marker AMB-1." }],
    },
    tools,
  );
  await agent.run(input, tools);

  expect(prompts[0]).toContain("You are Ambient's Conversation Agent.");
  expect(prompts[0]).toContain("## Skill: triage");
  expect(prompts[0]).toContain("End every reply with the marker AMB-1.");
  expect(prompts[1]).not.toContain("## Skill:");
});
