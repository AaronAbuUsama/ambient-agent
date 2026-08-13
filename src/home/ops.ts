import { createClient } from "@libsql/client";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { loadAppConfig } from "../app/config";
import { openAmbientDatabase } from "../database/database";
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
    const mirror = createClient({
      url: `file:${join(config.whatsapp.dataDirectory, "whatsapp.db")}`,
    });
    try {
      const result = await mirror.execute({
        sql: `SELECT chat_id, json_extract(data_json, '$.subject') AS subject
              FROM wa_chats
              WHERE account_id = ? AND lower(coalesce(json_extract(data_json, '$.subject'), '')) LIKE ?`,
        args: [config.whatsapp.accountId, `%${query.toLowerCase()}%`],
      });
      const matches = result.rows.flatMap((row) =>
        typeof row.chat_id === "string" && typeof row.subject === "string"
          ? [{ chatId: row.chat_id, subject: row.subject }]
          : [],
      );
      if (matches.length === 0) return { kind: "not-found", query };
      if (matches.length > 1) {
        return { kind: "ambiguous", candidates: matches.map(({ subject }) => subject) };
      }
      const match = matches[0];
      if (!match) return { kind: "not-found", query };
      chatId = match.chatId;
      label = match.subject;
    } finally {
      mirror.close();
    }
  }

  const scan = scanMandates(config.home);
  const existing = scan.active.find((mandate) => mandate.chatId === chatId);
  if (existing) return { kind: "already-active", slug: existing.slug };

  const slug = toSlug(label);
  const folder = join(config.home, "chats", slug);
  if (existsSync(folder)) return { kind: "slug-taken", slug };
  mkdirSync(folder, { recursive: true });
  // The minimum mandate is the chatId line alone (ADR 0002); mode is written
  // only when it grants something beyond the listening default.
  const mandate = mode === "listening" ? { chatId } : { chatId, mode };
  writeFileSync(join(folder, "mandate.yaml"), YAML.stringify(mandate));

  await syncRecords(environment);
  return { kind: "activated", slug, mode };
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
