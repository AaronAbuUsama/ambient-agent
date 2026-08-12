import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { expect, test } from "vite-plus/test";
import { createPiConversationAgent } from "./pi-agent";

const modelConfig = {
  provider: "faux",
  model: "faux",
  thinking: "off" as const,
  maxOutputTokens: 1024,
};

const input = {
  conversationId: "chat-1",
  instructions: "Be concise.",
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
  const models = createModels();
  models.setProvider(faux.provider);
  const sends: string[] = [];
  const recalls: string[] = [];
  const agent = createPiConversationAgent({
    resolveModel: () => ({ models, model: faux.getModel()! }),
  });

  const result = await agent.run(modelConfig, input, {
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
  const models = createModels();
  models.setProvider(faux.provider);
  const agent = createPiConversationAgent({
    resolveModel: () => ({ models, model: faux.getModel()! }),
  });

  const result = await agent.run(modelConfig, input, {
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
  const models = createModels();
  models.setProvider(faux.provider);
  const agent = createPiConversationAgent({
    resolveModel: () => ({ models, model: faux.getModel()! }),
  });

  await expect(
    agent.run({ ...modelConfig, maxOutputTokens: 321 }, input, {
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
