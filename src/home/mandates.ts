import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";

const slugPattern = /^[a-z0-9-]{1,64}$/;

/**
 * One agent grant: this chat's speaker may delegate to the named agent. A
 * bare grant (`github-issues:` alone) allows the definition as-is; a grant
 * may also carry per-tool narrowing fragments — the effective constraint is
 * definition ∩ grant, computed by the tool registry, never widened here.
 * Granting an agent to a chat is a disclosure decision: it authorizes the
 * chat's content to flow to that agent's destinations.
 */
const agentGrantSchema = z
  .strictObject({
    tools: z.record(z.string().min(1), z.unknown()).optional(),
  })
  .nullable()
  .transform((grant) => grant ?? {});

export interface AgentGrant {
  readonly tools?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * The mandate: the whole grant for one chat, one file (ADR 0002). Strict —
 * an unknown or misspelled key is a validation error, never silently ignored.
 * The minimum mandate is the chatId line alone: active, listening, defaults.
 */
export const mandateSchema = z.strictObject({
  chatId: z.string().min(1),
  mode: z.enum(["listening", "responding"]).default("listening"),
  instructions: z.string().min(1).optional(),
  memoryBrief: z.string().min(1).optional(),
  agents: z.record(z.string().regex(slugPattern), agentGrantSchema).optional(),
});

export interface ChatMandate {
  readonly slug: string;
  readonly chatId: string;
  readonly mode: "listening" | "responding";
  readonly instructions?: string | undefined;
  readonly memoryBrief?: string | undefined;
  readonly agents?: Readonly<Record<string, AgentGrant>> | undefined;
}

export interface BrokenChat {
  readonly slug: string;
  readonly problem: string;
}

export interface MandateScan {
  readonly active: readonly ChatMandate[];
  readonly broken: readonly BrokenChat[];
}

/**
 * Read every chat folder and split it into active mandates and broken chats.
 * Fail-closed (ADR 0002): a missing mandate, unparseable YAML, schema
 * violation, bad folder name, or two folders claiming one chat id makes the
 * chat broken — no winner-picking, no last-good. Brokenness is recomputable
 * from disk, never stored.
 */
export function scanMandates(home: string): MandateScan {
  const chatsDirectory = join(home, "chats");
  if (!existsSync(chatsDirectory)) return { active: [], broken: [] };

  const candidates: ChatMandate[] = [];
  const broken: BrokenChat[] = [];
  const folders = readdirSync(chatsDirectory, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory(),
  );
  for (const folder of folders) {
    const slug = folder.name;
    if (!slugPattern.test(slug)) {
      broken.push({ slug, problem: "folder name is not a valid slug (a-z, 0-9, dashes, max 64)" });
      continue;
    }
    const path = join(chatsDirectory, slug, "mandate.yaml");
    if (!existsSync(path)) {
      broken.push({ slug, problem: "mandate.yaml is missing" });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = YAML.parse(readFileSync(path, "utf8"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      broken.push({ slug, problem: `mandate.yaml is not valid YAML: ${message}` });
      continue;
    }
    const result = mandateSchema.safeParse(parsed);
    if (!result.success) {
      broken.push({ slug, problem: `mandate.yaml: ${z.prettifyError(result.error)}` });
      continue;
    }
    candidates.push({ slug, ...result.data });
  }

  const byChatId = new Map<string, ChatMandate[]>();
  for (const mandate of candidates) {
    const claimants = byChatId.get(mandate.chatId) ?? [];
    claimants.push(mandate);
    byChatId.set(mandate.chatId, claimants);
  }
  const active: ChatMandate[] = [];
  for (const claimants of byChatId.values()) {
    if (claimants.length === 1 && claimants[0]) {
      active.push(claimants[0]);
      continue;
    }
    for (const claimant of claimants) {
      const others = claimants
        .filter((other) => other.slug !== claimant.slug)
        .map((other) => other.slug)
        .join(", ");
      broken.push({ slug: claimant.slug, problem: `chat id is also bound by ${others}` });
    }
  }
  return { active, broken };
}
