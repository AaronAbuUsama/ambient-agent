import { expect, test } from "vite-plus/test";
import { modelsDocumentSchema, type ModelsDocument } from "./contract";
import { createModelRuntime } from "./runtime";

function document(overrides: {
  readonly providers?: Record<string, unknown>;
  readonly roles?: Record<string, unknown>;
}): ModelsDocument {
  return modelsDocumentSchema.parse({
    providers: overrides.providers ?? {
      qwen: {
        adapter: "openai-compatible",
        baseUrl: "https://qwen.invalid/v1",
        credential: { env: ["QWEN_API_KEY", "DASHSCOPE_API_KEY"] },
        models: {
          "qwen3.6-flash": { contextWindow: 262_144, maxTokens: 65_536, reasoning: true },
        },
      },
      vibe: {
        adapter: "openai-compatible",
        baseUrl: "http://127.0.0.1:8317/v1",
        credential: "none",
      },
    },
    roles: overrides.roles ?? {
      conversation: {
        provider: "qwen",
        model: "qwen3.6-flash",
        thinking: "off",
        maxOutputTokens: 4096,
      },
    },
  });
}

test("a configured role resolves one ready runner with its durable snapshot", () => {
  const runtime = createModelRuntime(document({}), { DASHSCOPE_API_KEY: "secret" });
  expect(runtime.roles).toEqual(["conversation"]);
  const runner = runtime.forRole("conversation");
  expect(runner.snapshot).toEqual({
    provider: "qwen",
    model: "qwen3.6-flash",
    thinking: "off",
    maxOutputTokens: 4096,
  });
  expect(runner.model).toMatchObject({
    provider: "qwen",
    id: "qwen3.6-flash",
    baseUrl: "https://qwen.invalid/v1",
    contextWindow: 262_144,
    maxTokens: 65_536,
    reasoning: true,
  });
});

test("a role whose provider credential is missing fails closed at startup", () => {
  expect(() => createModelRuntime(document({}), {})).toThrow(
    'model provider "qwen" requires one of QWEN_API_KEY, DASHSCOPE_API_KEY',
  );
});

test("a role referencing an unknown provider fails closed at startup", () => {
  expect(() =>
    createModelRuntime(
      document({ roles: { conversation: { provider: "missing", model: "some-model" } } }),
      {},
    ),
  ).toThrow('model role "conversation" references unknown provider "missing"');
});

test("an unconfigured role is not resolvable", () => {
  const runtime = createModelRuntime(document({}), { QWEN_API_KEY: "secret" });
  expect(() => runtime.forRole("memory")).toThrow('model role "memory" is not configured');
});

test("a keyless local provider resolves without secrets and applies metadata defaults", () => {
  const runtime = createModelRuntime(
    document({ roles: { worker: { provider: "vibe", model: "local-coder" } } }),
    {},
  );
  const runner = runtime.forRole("worker");
  expect(runner.snapshot).toEqual({
    provider: "vibe",
    model: "local-coder",
    thinking: "off",
    maxOutputTokens: 4096,
  });
  expect(runner.model).toMatchObject({
    provider: "vibe",
    id: "local-coder",
    baseUrl: "http://127.0.0.1:8317/v1",
    contextWindow: 131_072,
    maxTokens: 32_768,
    reasoning: false,
  });
});

test("adding another OpenAI-compatible provider is a configuration-only change", () => {
  const extended = document({
    providers: {
      qwen: {
        adapter: "openai-compatible",
        baseUrl: "https://qwen.invalid/v1",
        credential: { env: ["QWEN_API_KEY"] },
      },
      groq: {
        adapter: "openai-compatible",
        baseUrl: "https://groq.invalid/openai/v1",
        credential: { env: ["GROQ_API_KEY"] },
      },
    },
    roles: {
      conversation: { provider: "groq", model: "kimi-k3" },
    },
  });
  const runner = createModelRuntime(extended, { GROQ_API_KEY: "secret" }).forRole("conversation");
  expect(runner.model).toMatchObject({
    provider: "groq",
    id: "kimi-k3",
    baseUrl: "https://groq.invalid/openai/v1",
  });
});
