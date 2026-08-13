import { createClient } from "@libsql/client";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Read-only view of the retained account mirror for operator surfaces
 * (doctor's health readout, activate's chat discovery). The mirror's schema
 * and location stay this module's detail — callers speak in chats and
 * authentication, never tables.
 */

export interface MirrorChat {
  readonly chatId: string;
  readonly subject: string;
}

export type MirrorAuthState = "authenticated" | "no-credentials" | "no-state";

function mirrorPath(dataDirectory: string): string {
  return join(dataDirectory, "whatsapp.db");
}

/** Chats the account can see whose name matches the query (case-insensitive). */
export async function findMirrorChats(
  dataDirectory: string,
  accountId: string,
  query: string,
): Promise<readonly MirrorChat[]> {
  const path = mirrorPath(dataDirectory);
  if (!existsSync(path)) return [];
  const mirror = createClient({ url: `file:${path}` });
  try {
    const result = await mirror.execute({
      sql: `SELECT chat_id, json_extract(data_json, '$.subject') AS subject
            FROM wa_chats
            WHERE account_id = ? AND lower(coalesce(json_extract(data_json, '$.subject'), '')) LIKE ?`,
      args: [accountId, `%${query.toLowerCase()}%`],
    });
    return result.rows.flatMap((row) =>
      typeof row.chat_id === "string" && typeof row.subject === "string"
        ? [{ chatId: row.chat_id, subject: row.subject }]
        : [],
    );
  } finally {
    mirror.close();
  }
}

export interface AliasResolver {
  /** Canonical id for any known identity form; unknown ids pass through. */
  resolve(chatId: string): Promise<string>;
  /** The full native → canonical map, for the startup identity healer. */
  snapshot(): Promise<ReadonlyMap<string, string>>;
}

/**
 * One human, one id: whatsappd's contact aliases map every identity form
 * (phone-number jid, lid) to one canonical contact. Cached with a short TTL —
 * the table grows slowly as contacts sync — and an absent mirror resolves
 * everything to itself.
 */
export function createAliasResolver(
  dataDirectory: string,
  accountId: string,
  timeToLiveMs = 60_000,
): AliasResolver {
  let cache: Map<string, string> | undefined;
  let loadedAt = 0;
  const load = async (): Promise<Map<string, string>> => {
    if (cache && Date.now() - loadedAt < timeToLiveMs) return cache;
    const path = mirrorPath(dataDirectory);
    const next = new Map<string, string>();
    if (existsSync(path)) {
      const mirror = createClient({ url: `file:${path}` });
      try {
        const result = await mirror.execute({
          sql: "SELECT native_id, contact_id FROM wa_contact_aliases WHERE account_id = ?",
          args: [accountId],
        });
        for (const row of result.rows) {
          if (typeof row.native_id === "string" && typeof row.contact_id === "string") {
            next.set(row.native_id, row.contact_id);
          }
        }
      } finally {
        mirror.close();
      }
    }
    cache = next;
    loadedAt = Date.now();
    return next;
  };
  return {
    async resolve(chatId) {
      return (await load()).get(chatId) ?? chatId;
    },
    snapshot: load,
  };
}

/** Whether the account has credentials in the retained state. */
export async function mirrorAuthState(
  dataDirectory: string,
  accountId: string,
): Promise<MirrorAuthState> {
  const path = mirrorPath(dataDirectory);
  if (!existsSync(path)) return "no-state";
  const mirror = createClient({ url: `file:${path}` });
  try {
    const result = await mirror.execute({
      sql: "SELECT count(*) AS n FROM wa_auth WHERE account = ? AND key = 'creds'",
      args: [accountId],
    });
    return Number(result.rows[0]?.n ?? 0) > 0 ? "authenticated" : "no-credentials";
  } finally {
    mirror.close();
  }
}
