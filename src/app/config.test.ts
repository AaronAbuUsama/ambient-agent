import { expect, test } from "vite-plus/test";
import { loadAppConfig } from "./config";

test("history backfill is unlimited by default", () => {
  const config = loadAppConfig({});
  expect(config.whatsapp.historyBackfillLimit).toBeUndefined();
  expect(config.database.url).toMatch(/\/data\/ambient\.db$/);
  expect(config.models.conversation).toEqual({
    provider: "qwen",
    model: "qwen3.6-flash",
    thinking: "off",
    maxOutputTokens: 4096,
  });
  expect(config.models.evaluator).toBeUndefined();
  expect(config.conversation.scheduling).toEqual({
    debounceMs: 750,
    maximumWaitMs: 5_000,
    leaseMs: 120_000,
    maximumItemsPerRun: 50,
  });
  expect(config.conversation.enabled).toBe(false);
  expect(config.conversation.outboundMode).toBe("loopback");
});

test("history backfill accepts an explicit deployment limit", () => {
  expect(loadAppConfig({ WHATSAPP_BACKFILL_LIMIT: "5000" }).whatsapp.historyBackfillLimit).toBe(
    5000,
  );
});

test.each(["all", "1"])("history backfill rejects invalid limit %s", (limit) => {
  expect(() => loadAppConfig({ WHATSAPP_BACKFILL_LIMIT: limit })).toThrow(
    "WHATSAPP_BACKFILL_LIMIT must be a positive multiple of 25",
  );
});

test("role model configuration overrides shared defaults", () => {
  const config = loadAppConfig({
    MODEL_PROVIDER: "shared-provider",
    AMBIENT_MODEL: "shared-model",
    CONVERSATION_MODEL: "conversation-model",
    CONVERSATION_MODEL_THINKING: "medium",
    CONVERSATION_MODEL_MAX_OUTPUT_TOKENS: "8192",
    EVALUATOR_MODEL: "evaluator-model",
  });

  expect(config.models.conversation).toEqual({
    provider: "shared-provider",
    model: "conversation-model",
    thinking: "medium",
    maxOutputTokens: 8192,
  });
  expect(config.models.worker.model).toBe("shared-model");
  expect(config.models.evaluator?.model).toBe("evaluator-model");
});

test("conversation scheduling accepts explicit deployment values", () => {
  const config = loadAppConfig({
    CONVERSATION_ENABLED: "true",
    CONVERSATION_OUTBOUND_MODE: "conversation",
    CONVERSATION_INSTRUCTIONS: "Be concise.",
    CONVERSATION_DEBOUNCE_MS: "1000",
    CONVERSATION_MAXIMUM_WAIT_MS: "6000",
    CONVERSATION_LEASE_MS: "90000",
    CONVERSATION_MAXIMUM_ITEMS_PER_RUN: "25",
  });
  expect(config.conversation).toMatchObject({
    enabled: true,
    outboundMode: "conversation",
    instructions: "Be concise.",
  });
  expect(config.conversation.scheduling).toEqual({
    debounceMs: 1000,
    maximumWaitMs: 6000,
    leaseMs: 90000,
    maximumItemsPerRun: 25,
  });
});

test.each([
  ["CONVERSATION_ENABLED", "yes", 'CONVERSATION_ENABLED must be "true" or "false"'],
  [
    "CONVERSATION_OUTBOUND_MODE",
    "disabled",
    'CONVERSATION_OUTBOUND_MODE must be "loopback" or "conversation"',
  ],
] as const)("conversation rejects invalid %s", (name, value, message) => {
  expect(() =>
    loadAppConfig({
      [name]: value,
    }),
  ).toThrow(message);
});

test("conversation scheduling values are independently configurable", () => {
  expect(
    loadAppConfig({
      CONVERSATION_DEBOUNCE_MS: "1000",
      CONVERSATION_MAXIMUM_WAIT_MS: "6000",
      CONVERSATION_LEASE_MS: "90000",
      CONVERSATION_MAXIMUM_ITEMS_PER_RUN: "25",
    }).conversation.scheduling,
  ).toEqual({
    debounceMs: 1000,
    maximumWaitMs: 6000,
    leaseMs: 90000,
    maximumItemsPerRun: 25,
  });
});

test("conversation maximum wait cannot be shorter than its debounce", () => {
  expect(() =>
    loadAppConfig({
      CONVERSATION_DEBOUNCE_MS: "1000",
      CONVERSATION_MAXIMUM_WAIT_MS: "500",
    }),
  ).toThrow("CONVERSATION_MAXIMUM_WAIT_MS must be at least CONVERSATION_DEBOUNCE_MS");
});
