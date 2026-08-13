import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { loadAppConfig } from "../app/config";
import { openAmbientDatabase } from "../database/database";
import { findMirrorChats } from "../whatsapp/mirror";
import { ambientHome } from "./init";
import { scanMandates } from "./mandates";

/**
 * The ops surface: the same operations the CLI exposes now become the Root's
 * tools at Root v1 — which is why they return typed results instead of
 * printing (the caller renders text or JSON).
 */

export type ActivateResult =
  | { readonly kind: "activated"; readonly slug: string; readonly mode: "listening" | "responding" }
  | { readonly kind: "already-active"; readonly slug: string }
  | { readonly kind: "ambiguous"; readonly candidates: readonly string[] }
  | { readonly kind: "not-found"; readonly query: string }
  | { readonly kind: "slug-taken"; readonly slug: string };

function toSlug(label: string): string {
  const slug = label
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug.length > 0 ? slug : "chat";
}

/** A bare phone number is a DM chat id waiting for its suffix. */
function asChatId(query: string): string | undefined {
  if (query.includes("@")) return query;
  const digits = query.replaceAll(/[\s+-]/g, "");
  if (/^\d{6,}$/.test(digits)) return `${digits}@s.whatsapp.net`;
  return undefined;
}

/**
 * Activate a chat: resolve the query against the account's mirror, create
 * `chats/<slug>/mandate.yaml` (config by convention — the CLI writes, humans
 * only edit), and sync the records so it takes effect without a restart.
 */
export async function activateChat(
  environment: NodeJS.ProcessEnv,
  query: string,
  mode: "listening" | "responding",
): Promise<ActivateResult> {
  const config = loadAppConfig(environment);

  let chatId = asChatId(query);
  let label = chatId === undefined ? query : (chatId.split("@")[0] ?? query);
  if (chatId === undefined) {
    const matches = await findMirrorChats(
      config.whatsapp.dataDirectory,
      config.whatsapp.accountId,
      query,
    );
    if (matches.length === 0) return { kind: "not-found", query };
    if (matches.length > 1) {
      return { kind: "ambiguous", candidates: matches.map(({ subject }) => subject) };
    }
    const match = matches[0];
    if (!match) return { kind: "not-found", query };
    chatId = match.chatId;
    label = match.subject;
  }

  const scan = scanMandates(config.home);
  const existing = scan.active.find((mandate) => mandate.chatId === chatId);
  if (existing) return { kind: "already-active", slug: existing.slug };

  const slug = toSlug(label);
  const folder = join(config.home, "chats", slug);
  if (existsSync(folder)) return { kind: "slug-taken", slug };
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, "mandate.yaml"),
    renderMandate({ chatId, mode, isMaster: chatId === config.master?.chatId }),
  );

  await syncRecords(environment);
  return { kind: "activated", slug, mode };
}

/**
 * The mandate the CLI writes: every field present — real when granted,
 * commented when the default is active — so the file teaches its own
 * vocabulary. The strict schema still fails loudly on unknown keys.
 */
export function renderMandate(options: {
  readonly chatId: string;
  readonly mode: "listening" | "responding";
  readonly memoryBrief?: string | undefined;
  readonly isMaster?: boolean;
}): string {
  const lines: string[] = [
    "# The whole grant for this chat (ADR 0002). Commented fields are active",
    "# defaults — uncomment to override. Unknown keys fail loudly.",
  ];
  if (options.isMaster === true) {
    lines.push("# This is the master's direct line — the Root's seat at Root v1.");
  }
  lines.push(`chatId: ${options.chatId} # identity — written by the CLI`);
  lines.push(
    options.mode === "responding"
      ? "mode: responding # remove to return to listening (memory only, silent)"
      : "# mode: responding # default: listening — memory only, never speaks",
  );
  lines.push("# instructions: |", "#   Per-chat override of the standard speaker prompt.");
  if (options.memoryBrief === undefined) {
    lines.push("# memoryBrief: |", "#   What this chat's memory is FOR — its digestion focus.");
  } else {
    lines.push("memoryBrief: |");
    for (const line of options.memoryBrief.split("\n")) lines.push(`  ${line}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Re-derive the records from the mandate files — what startup does, on demand. */
export async function syncRecords(environment: NodeJS.ProcessEnv): Promise<void> {
  const config = loadAppConfig(environment);
  const database = await openAmbientDatabase(config.database.url);
  try {
    const scan = scanMandates(config.home);
    await database.repositories.speakers.sync(
      scan.active.map((mandate) => ({
        conversationId: mandate.chatId,
        mode: mandate.mode,
        ...(mandate.instructions === undefined ? {} : { instructions: mandate.instructions }),
        ...(mandate.memoryBrief === undefined ? {} : { memoryBrief: mandate.memoryBrief }),
      })),
    );
  } finally {
    await database.close();
  }
}

/**
 * Record the master's direct line in config.yaml. Accepts a phone number
 * (digits become `<number>@s.whatsapp.net`) or a full chat id. Comment-
 * preserving: the document is edited in place, not regenerated.
 */
export function setMaster(environment: NodeJS.ProcessEnv, input: string): { chatId: string } {
  const chatId = asChatId(input);
  if (chatId === undefined) {
    throw new Error(`"${input}" is not a phone number or chat id`);
  }
  const path = environment.AMBIENT_CONFIG ?? join(ambientHome(environment), "config.yaml");
  const document = YAML.parseDocument(readFileSync(path, "utf8"));
  document.setIn(["master", "chatId"], chatId);
  writeFileSync(path, document.toString());
  return { chatId };
}
