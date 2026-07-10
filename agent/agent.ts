/**
 * Eve runtime config — model selection for the GitHub concierge agent.
 *
 * Uses `@ai-sdk/anthropic` directly (no Vercel AI Gateway hop), so the only
 * credential this agent needs is `ANTHROPIC_API_KEY`. See
 * https://eve.dev/docs/agent-config for the full `defineAgent` surface.
 */
import { anthropic } from "@ai-sdk/anthropic";
import { defineAgent } from "eve";

// Direct-provider model ids use Anthropic's native id format. "claude-sonnet-5"
// is Anthropic's current Sonnet release; override with EVE_MODEL_ID to pin a
// different one (e.g. "claude-opus-4-5") without editing code.
const modelId = process.env.EVE_MODEL_ID ?? "claude-sonnet-5";

export default defineAgent({
  model: anthropic(modelId),
  // Keep the loop tight for a chat surface: a runaway tool-call chain in a
  // group chat is much more visible (and annoying) than in a web UI.
  limits: {
    maxOutputTokensPerSession: 200_000,
  },
});
