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
