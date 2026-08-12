import { expect, test } from "vite-plus/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAppConfig } from "./config";

async function withConfigFile(
  content: string,
  work: (path: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ambient-config-"));
  const path = join(directory, "ambient.config.json");
  await writeFile(path, content);
  try {
    await work(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("history backfill is unlimited by default", () => {
  const config = loadAppConfig({});
  expect(config.whatsapp.historyBackfillLimit).toBeUndefined();
  expect(config.database.url).toMatch(/\/data\/ambient\.db$/);
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

test("the committed configuration document supplies the Qwen deployment by default", () => {
  const config = loadAppConfig({});
  expect(config.models.roles.conversation).toEqual({
    provider: "qwen",
    model: "qwen3.6-flash",
    thinking: "off",
    maxOutputTokens: 4096,
  });
  expect(config.models.providers.qwen).toMatchObject({
    adapter: "openai-compatible",
    credential: { env: ["QWEN_API_KEY", "DASHSCOPE_API_KEY"] },
  });
  expect(config.models.roles.worker).toBeUndefined();
});

test("a configuration document replaces the built-in models section entirely", async () => {
  await withConfigFile(
    JSON.stringify({
      models: {
        providers: {
          local: {
            adapter: "openai-compatible",
            baseUrl: "http://127.0.0.1:9999/v1",
            credential: "none",
          },
        },
        roles: {
          conversation: { provider: "local", model: "test-model", maxOutputTokens: 512 },
        },
      },
    }),
    async (path) => {
      const config = loadAppConfig({ AMBIENT_CONFIG: path });
      expect(config.models.roles.conversation).toEqual({
        provider: "local",
        model: "test-model",
        thinking: "off",
        maxOutputTokens: 512,
      });
      expect(config.models.providers.qwen).toBeUndefined();
    },
  );
});

test("an explicitly configured document path must exist", () => {
  expect(() => loadAppConfig({ AMBIENT_CONFIG: "/nonexistent/ambient.config.json" })).toThrow(
    'cannot read configuration file "/nonexistent/ambient.config.json"',
  );
});

test("an invalid configuration document fails closed", async () => {
  await withConfigFile("not json", async (path) => {
    expect(() => loadAppConfig({ AMBIENT_CONFIG: path })).toThrow("is not valid JSON");
  });
  await withConfigFile(JSON.stringify({ models: { providers: {} } }), async (path) => {
    expect(() => loadAppConfig({ AMBIENT_CONFIG: path })).toThrow();
  });
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
