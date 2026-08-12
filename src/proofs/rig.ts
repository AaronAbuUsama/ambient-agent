import { readFileSync } from "node:fs";
import { z } from "zod";
import type { AppConfig } from "../app/config";

/**
 * Shared policy for proofs that run on the two-account rig.
 *
 * The subject is the `android` profile; sends resolve against the private
 * allowlist beside the profiles and refuse anything unlisted (a missing file
 * means no sends — the correct failure). Nothing derived from the profiles is
 * printed or committed.
 */
const allowlistSchema = z.object({
  groups: z.array(z.string().min(1)),
  chats: z.array(z.string().min(1)),
  subjectChats: z.array(z.string().min(1)).min(1),
  peerChats: z.array(z.string().min(1)).min(1),
});

export const RIG_PRIVATE = ".proof-private";

export function rigAllowlist(): z.infer<typeof allowlistSchema> {
  return allowlistSchema.parse(
    JSON.parse(readFileSync(`${RIG_PRIVATE}/send-allowlist.json`, "utf8")),
  );
}

/** The base config rebased onto the rig's android subject profile. */
export function rigConfig(base: AppConfig): AppConfig {
  const hasQwenKey = Boolean(process.env.QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY);
  return {
    ...base,
    database: { url: `file:${RIG_PRIVATE}/android/ambient.db` },
    whatsapp: { ...base.whatsapp, accountId: "android", dataDirectory: `${RIG_PRIVATE}/android` },
    models: hasQwenKey
      ? base.models
      : {
          ...base.models,
          roles: {
            ...base.models.roles,
            // gemini pool: the sonnet pool intermittently demands thinking.
            conversation: {
              provider: "vibe",
              model: "gemini-3.6-flash-high",
              thinking: "off",
              maxOutputTokens: 1024,
            },
          },
        },
  };
}
