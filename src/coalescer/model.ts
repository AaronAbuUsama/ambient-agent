/**
 * The language model the voice and the worker both run on — one place, two code paths.
 *
 * 1. OPENAI_API_KEY set → a plain OpenAI model billed to that API key. Works ANYWHERE
 *    (local, CI, the VPS) — this is the production path, and the one to drop a test key
 *    into. Model id from OPENAI_MODEL (default `gpt-4o`).
 * 2. else → `experimental_chatgpt()`, billed to the local ChatGPT/Codex subscription via
 *    `${CODEX_HOME}/auth.json`. No API key, but LOCAL-DEV ONLY (fails where there's no
 *    codex login).
 *
 * Choosing on the *presence of a key* (not NODE_ENV) keeps it dead simple: set the key to
 * use it, unset it to fall back to the subscription. Both return an ai@7 LanguageModel, so
 * `streamText` upstream is identical either way.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { experimental_chatgpt } from "eve/models/openai";

const apiKey = (): string | undefined => process.env.OPENAI_API_KEY?.trim() || undefined;
const openaiModelId = (): string => process.env.OPENAI_MODEL?.trim() || "gpt-4o";

export const makeModel = (): LanguageModel => {
  const key = apiKey();
  if (key) return createOpenAI({ apiKey: key })(openaiModelId());
  return experimental_chatgpt();
};

/**
 * One human-readable line naming the active model source, for the startup banner —
 * so it's never a mystery which account/key is being billed. For the subscription path
 * it also checks the creds file and warns loudly if it's missing.
 */
export const describeModel = (): string => {
  const key = apiKey();
  if (key) return `🔑 model: OpenAI API key — ${openaiModelId()}`;
  const home = process.env.CODEX_HOME?.trim() || join(process.env.HOME ?? "~", ".codex");
  const authPath = join(home, "auth.json");
  try {
    const auth = JSON.parse(readFileSync(authPath, "utf8")) as { tokens?: { account_id?: string } };
    return `🔑 model: ChatGPT subscription — account ${auth.tokens?.account_id ?? "unknown"} (${authPath})`;
  } catch {
    return `🔑 ⚠️  no model creds — set OPENAI_API_KEY, or run \`pnpm run login\` (no auth.json at ${authPath})`;
  }
};
