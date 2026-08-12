import { expect, test } from "vite-plus/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAppConfig } from "./config";

const models = {
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
};

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

test("the committed configuration document supplies the deployment defaults", () => {
  const config = loadAppConfig({});
  expect(config.whatsapp.accountId).toBe("main");
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

test("a configuration document owns every structured section", async () => {
  await withConfigFile(
    JSON.stringify({
      database: { url: "file:/tmp/custom.db" },
      whatsapp: { accountId: "second", dataDirectory: "/var/ambient", historyBackfillLimit: 75 },
      conversation: {
        enabled: true,
        outboundMode: "conversation",
        instructions: "Be concise.",
        scheduling: {
          debounceMs: 1_000,
          maximumWaitMs: 6_000,
          leaseMs: 90_000,
          maximumItemsPerRun: 25,
        },
      },
      logging: { level: "info" },
      models,
    }),
    async (path) => {
      const config = loadAppConfig({ AMBIENT_CONFIG: path });
      expect(config.database.url).toBe("file:/tmp/custom.db");
      expect(config.whatsapp).toEqual({
        accountId: "second",
        dataDirectory: "/var/ambient",
        historyBackfillLimit: 75,
      });
      expect(config.conversation).toMatchObject({
        enabled: true,
        outboundMode: "conversation",
        instructions: "Be concise.",
      });
      expect(config.conversation.scheduling).toEqual({
        debounceMs: 1_000,
        maximumWaitMs: 6_000,
        leaseMs: 90_000,
        maximumItemsPerRun: 25,
      });
      expect(config.logging.level).toBe("info");
      expect(config.models.roles.conversation?.model).toBe("test-model");
    },
  );
});

test("deployment environment overrides win over the document", async () => {
  await withConfigFile(
    JSON.stringify({ database: { url: "file:/tmp/document.db" }, models }),
    async (path) => {
      const config = loadAppConfig({
        AMBIENT_CONFIG: path,
        AMBIENT_DATABASE_URL: "file:/tmp/override.db",
        WHATSAPP_DATA_DIR: "/tmp/override-data",
        WA_LOG_LEVEL: "debug",
      });
      expect(config.database.url).toBe("file:/tmp/override.db");
      expect(config.whatsapp.dataDirectory).toBe("/tmp/override-data");
      expect(config.logging.level).toBe("debug");
    },
  );
});

test("an explicitly configured document path must exist", () => {
  expect(() => loadAppConfig({ AMBIENT_CONFIG: "/nonexistent/ambient.config.json" })).toThrow(
    'cannot read configuration file "/nonexistent/ambient.config.json"',
  );
});

test.each([
  ["not json", "is not valid JSON"],
  [JSON.stringify({ models: { providers: {} } }), undefined],
  [JSON.stringify({ whatsapp: { historyBackfillLimit: 30 }, models }), undefined],
  [
    JSON.stringify({
      conversation: { scheduling: { debounceMs: 1_000, maximumWaitMs: 500 } },
      models,
    }),
    "maximumWaitMs must be at least debounceMs",
  ],
  [JSON.stringify({ conversation: { outboundMode: "disabled" }, models }), undefined],
] as const)("invalid configuration documents fail closed (%#)", async (content, message) => {
  await withConfigFile(content, async (path) => {
    const load = () => loadAppConfig({ AMBIENT_CONFIG: path });
    if (message) {
      expect(load).toThrow(message);
    } else {
      expect(load).toThrow();
    }
  });
});
