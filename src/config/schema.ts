/**
 * The typed shape of the app's configuration and where it lives on disk.
 *
 * This is the prefactor for the Eve migration (ticket #5, design G6): new
 * gateway/agent code reads a validated `AppConfig` loaded from a persisted
 * file, NEVER the ambient environment. The existing env-var reads stay put
 * until their code paths move to Eve (retired at cut-over, ticket #13).
 *
 * The schema is the single source of truth: `AppConfig` is inferred from it,
 * so the type and the runtime validation can never drift apart.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/**
 * Canonical config location. `~/.wa-agent/config.json`. We resolve `~` with
 * `os.homedir()` rather than an env var on purpose: this module is guarded to
 * read zero environment variables (see tests/config/config.test.ts), because
 * config must have exactly one source — the file — not a mix of file and
 * ambient environment.
 */
export const DEFAULT_CONFIG_PATH = join(homedir(), ".wa-agent", "config.json");

/** Which WhatsApp chats the bot listens to, and how it addresses itself. */
const WhatsappSchema = z.object({
  /** Allow-listed chat JIDs the bot participates in. Empty = none until set. */
  chats: z.array(z.string()).default([]),
  /**
   * The bot's per-chat `@lid` address, when known. Optional: it can be
   * discovered at runtime from the live session, so config need not pin it.
   */
  botLid: z.string().optional(),
  /** Whether the bot answers 1:1 direct messages (not just group chats). */
  allowDm: z.boolean().default(false),
});

/** GitHub credentials and the repos the bot may read/write. */
const GithubSchema = z.object({
  /** PAT with `repo` scope. Required — the bot can do nothing without it. */
  token: z.string().min(1, "github.token must be a non-empty token"),
  /** Default `owner/repo` for commands that don't name one. Required. */
  repo: z.string().min(1, 'github.repo must be set (e.g. "owner/repo")'),
  /**
   * Write allow-list: the ONLY repos the bot may modify. Empty means "fall
   * back to `repo`" — the loopback/gateway code applies that default; the
   * schema keeps it a plain list so the file stays declarative.
   */
  allowedRepos: z.array(z.string()).default([]),
});

/** Which model provider backs the agent, and its credentials. */
const ModelSchema = z.object({
  /**
   * `"codex"` rides the Codex/ChatGPT subscription (OAuth, no API key);
   * `"openai"` uses a plain OpenAI API key.
   */
  source: z.enum(["codex", "openai"]),
  /** OpenAI API key. Required when `source === "openai"` (see refinement). */
  openaiKey: z.string().optional(),
  /** Optional model slug override (e.g. "gpt-5.6-sol"). */
  modelId: z.string().optional(),
});

/**
 * The whole config. A single `superRefine` enforces the cross-field rule that
 * a type alone can't: choosing the `openai` provider without a key is a
 * half-filled file, and we want that to fail loudly at load, not mysteriously
 * at the first model call.
 */
export const AppConfigSchema = z
  .object({
    whatsapp: WhatsappSchema,
    github: GithubSchema,
    model: ModelSchema,
  })
  .superRefine((cfg, ctx) => {
    if (cfg.model.source === "openai" && !cfg.model.openaiKey?.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["model", "openaiKey"],
        message: 'model.openaiKey is required when model.source is "openai"',
      });
    }
  });

/** The typed config the app consumes. Inferred from the schema — never drifts. */
export type AppConfig = z.infer<typeof AppConfigSchema>;
