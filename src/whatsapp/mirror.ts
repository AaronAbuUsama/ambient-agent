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
