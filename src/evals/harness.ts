// flue-blueprint: tooling/vitest-evals@1
import { createFlueClient, type FlueConversationMessage } from "@flue/sdk";
import { createHarness, type JsonValue, toJsonValue, type TranscriptEvent } from "vitest-evals";

export interface FlueAgentHarnessOptions {
  agentName: string;
  baseUrl?: string;
  token?: string;
  headers?: Record<string, string>;
}

export interface FixtureHistorySeed {
  scope: "current" | "other";
  text: string;
  chatId?: string;
}

export interface FlueAgentEvalInput {
  message: string;
  fixture?: {
    resetWhatsApp?: boolean;
    history?: FixtureHistorySeed[];
  };
}

export type FlueAgentEvalOutput = {
  text: string;
  instanceId: string;
  whatsappEvents: JsonValue[];
};

const jsonRecord = (value: unknown): Record<string, JsonValue> | undefined => {
  const json = toJsonValue(value);
  if (json === undefined) return undefined;
  if (json !== null && typeof json === "object" && !Array.isArray(json)) return json as Record<string, JsonValue>;
  return { value: json };
};

const conversationEvents = (messages: FlueConversationMessage[]): TranscriptEvent[] =>
  messages.flatMap((message) => {
    const events: TranscriptEvent[] = [];
    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    if (text.length > 0) events.push({ type: "message", role: message.role, content: text });

    for (const part of message.parts) {
      if (part.type !== "dynamic-tool") continue;
      events.push({
        type: "tool_call",
        id: part.toolCallId,
        name: part.toolName,
        ...(jsonRecord(part.input) === undefined ? {} : { arguments: jsonRecord(part.input) }),
      });
      if (part.state === "output-available") {
        events.push({
          type: "tool_result",
          toolCallId: part.toolCallId,
          name: part.toolName,
          content: toJsonValue(part.output),
        });
      } else if (part.state === "output-error") {
        events.push({
          type: "tool_result",
          toolCallId: part.toolCallId,
          name: part.toolName,
          error: { message: part.errorText },
        });
      }
    }
    return events;
  });

const checkedFetch = async (url: string, init?: RequestInit): Promise<Response> => {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`Fixture request ${init?.method ?? "GET"} ${url} failed: ${await response.text()}`);
  return response;
};

const seedFixture = async (
  baseUrl: string,
  instanceId: string,
  fixture: NonNullable<FlueAgentEvalInput["fixture"]>,
): Promise<void> => {
  if (fixture.resetWhatsApp === true) {
    await checkedFetch(`${baseUrl}/test/whatsapp/events`, { method: "DELETE" });
  }
  for (const [index, seed] of (fixture.history ?? []).entries()) {
    const chatId = seed.scope === "current" ? instanceId : (seed.chatId ?? `eval-other-${crypto.randomUUID()}@g.us`);
    await checkedFetch(`${baseUrl}/test/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: `eval-history-${crypto.randomUUID()}-${index}`,
        chatId,
        from: "alice@s.whatsapp.net",
        pushName: "Alice",
        text: seed.text,
        timestamp: Date.now() + index,
        isGroup: true,
        fromMe: false,
        live: true,
        mentions: [],
      }),
    });
  }
};

export function createFlueAgentHarness(options: FlueAgentHarnessOptions) {
  const baseUrl = options.baseUrl ?? process.env.FLUE_BASE_URL ?? "http://127.0.0.1:3583";
  const client = createFlueClient({ baseUrl, token: options.token, headers: options.headers });

  return createHarness<FlueAgentEvalInput, FlueAgentEvalOutput>({
    name: `flue-${options.agentName}-agent`,
    run: async ({ input, signal }) => {
      const startedAt = performance.now();
      const instanceId = `eval-${crypto.randomUUID()}@g.us`;
      if (input.fixture !== undefined) await seedFixture(baseUrl, instanceId, input.fixture);

      const invocation = await client.agents.prompt(options.agentName, instanceId, {
        message: input.message,
        signal,
      });
      const history = await client.agents.history(options.agentName, instanceId, { signal });
      const events = conversationEvents(history.messages);
      const whatsappEvents =
        input.fixture === undefined
          ? []
          : ((await checkedFetch(`${baseUrl}/test/whatsapp/events`)).json() as Promise<JsonValue[]>);

      return {
        output: {
          text: invocation.result.text,
          instanceId,
          whatsappEvents: await whatsappEvents,
        },
        events,
        usage: {
          provider: invocation.result.model.provider,
          model: invocation.result.model.id,
          inputTokens: invocation.result.usage.input,
          outputTokens: invocation.result.usage.output,
          totalTokens: invocation.result.usage.totalTokens,
          toolCalls: events.filter((event) => event.type === "tool_call").length,
          metadata: { cost: invocation.result.usage.cost.total },
        },
        timings: { totalMs: performance.now() - startedAt },
        artifacts: { instanceId, submissionId: invocation.submissionId },
      };
    },
  });
}
