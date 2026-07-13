import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LanguageModel } from "ai";
import { experimental_chatgpt } from "eve/models/openai";

const DEFAULT_SUBSCRIPTION_MODEL = "gpt-5.6-luna";
const SUBSCRIPTION_REASONING = "low" as const;
const LUNA_MINIMUM_CODEX_VERSION = "0.144.1";

type CodexAuth = {
  auth_mode?: unknown;
  tokens?: {
    access_token?: unknown;
    refresh_token?: unknown;
  } | null;
};

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Luna is served to ChatGPT-subscription clients through Codex's Responses Lite
 * contract. Eve 0.22.5 sends an ordinary Responses request, which the backend
 * rejects as `Model not found gpt-5.6-luna`. Keep this narrow compatibility
 * shim at the transport boundary until Eve's adapter implements Responses Lite.
 */
export const prepareLunaResponsesLiteRequest = (
  headers: Headers,
  body: unknown,
): { readonly headers: Headers; readonly body: unknown } => {
  if (!isRecord(body) || body.model !== DEFAULT_SUBSCRIPTION_MODEL) return { headers, body };

  const input = Array.isArray(body.input)
    ? body.input.map((item) =>
        isRecord(item) && !("type" in item) && "role" in item
          ? { type: "message", ...item }
          : item,
      )
    : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const prefix: unknown[] = [{ type: "additional_tools", role: "developer", tools }];
  if (nonEmptyString(body.instructions)) {
    prefix.push({
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: body.instructions }],
    });
  }

  const { instructions: _instructions, tools: _tools, ...rest } = body;
  headers.set("originator", "codex_exec");
  headers.set("version", LUNA_MINIMUM_CODEX_VERSION);
  headers.set("x-openai-internal-codex-responses-lite", "true");

  return {
    headers,
    body: {
      ...rest,
      input: [...prefix, ...input],
      parallel_tool_calls: false,
      reasoning: {
        ...(isRecord(body.reasoning) ? body.reasoning : {}),
        context: "all_turns",
      },
    },
  };
};

const requestUrl = (input: Parameters<typeof fetch>[0]): string =>
  input instanceof Request ? input.url : input.toString();

const responsesLiteFetch = (upstream: typeof fetch): typeof fetch =>
  async (input, init) => {
    if (
      !requestUrl(input).includes("/backend-api/codex/responses") ||
      typeof init?.body !== "string"
    ) {
      return upstream(input, init);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(init.body);
    } catch {
      return upstream(input, init);
    }
    const prepared = prepareLunaResponsesLiteRequest(new Headers(init.headers), parsed);
    return upstream(input, {
      ...init,
      headers: prepared.headers,
      body: JSON.stringify(prepared.body),
    });
  };

const codexAuthPath = (): string => {
  const home = process.env.CODEX_HOME?.trim() || join(process.env.HOME ?? "~", ".codex");
  return join(home, "auth.json");
};

/** Refuse Eve's API-key fallback: this app is subscription-only. */
const assertChatGptSubscriptionLogin = (): string => {
  const authPath = codexAuthPath();
  let auth: CodexAuth;

  try {
    auth = JSON.parse(readFileSync(authPath, "utf8")) as CodexAuth;
  } catch {
    throw new Error(
      `No readable ChatGPT subscription login at ${authPath}. Run \`pnpm run login\`.`,
    );
  }

  const hasOAuthToken =
    nonEmptyString(auth.tokens?.access_token) || nonEmptyString(auth.tokens?.refresh_token);
  if (auth.auth_mode !== "chatgpt" || !hasOAuthToken) {
    throw new Error(
      `Codex auth at ${authPath} is not a ChatGPT subscription login. Run \`pnpm run login\`.`,
    );
  }

  return authPath;
};

const subscriptionModel = (slug?: string): LanguageModel => {
  assertChatGptSubscriptionLogin();
  const model = slug?.trim() || DEFAULT_SUBSCRIPTION_MODEL;
  if (model !== DEFAULT_SUBSCRIPTION_MODEL) return experimental_chatgpt(model);

  // createCodexFetch captures global fetch when experimental_chatgpt() is
  // constructed. Install the compatibility wrapper only for that synchronous
  // construction, then immediately restore the process global.
  const upstream = globalThis.fetch;
  globalThis.fetch = responsesLiteFetch(upstream);
  try {
    return experimental_chatgpt(model);
  } finally {
    globalThis.fetch = upstream;
  }
};

/** Keep the model and its required inference policy atomic at every call site. */
export const subscriptionModelSettings = (slug?: string) => ({
  model: subscriptionModel(slug),
  reasoning: SUBSCRIPTION_REASONING,
});

export const describeSubscriptionModel = (): string => {
  try {
    return `🔑 model: ChatGPT subscription (${assertChatGptSubscriptionLogin()})`;
  } catch (error) {
    return `🔑 ⚠️  ${error instanceof Error ? error.message : String(error)}`;
  }
};
