import { expect, test } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAmbientDatabase, type AmbientDatabase } from "./database";

async function withDatabase(work: (database: AmbientDatabase) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ambient-identity-"));
  const database = await openAmbientDatabase(`file:${join(directory, "ambient.db")}`);
  try {
    await work(database);
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const LID = "204@lid";
const PN = "971@s.whatsapp.net";

test("healing rewrites plain rows and merges keyed rows toward canonical", async () => {
  await withDatabase(async (database) => {
    // A lid-form record (retained before the alias was known) AND a canonical
    // one: the canonical row must win, the lid row must disappear.
    await database.repositories.speakers.sync([
      { conversationId: LID, mode: "listening", attendFrom: "2026-08-01T00:00:00Z" },
      { conversationId: PN, mode: "responding", attendFrom: "2026-08-02T00:00:00Z" },
    ]);
    const rewritten = await database.repositories.identity.canonicalize(new Map([[LID, PN]]));
    expect(rewritten).toBeGreaterThanOrEqual(1);
    const records = await database.repositories.speakers.current();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ conversationId: PN, mode: "responding" });

    // Idempotent: a second run rewrites nothing.
    expect(await database.repositories.identity.canonicalize(new Map([[LID, PN]]))).toBe(0);
  });
});

test("a lid-only keyed row is renamed to canonical", async () => {
  await withDatabase(async (database) => {
    await database.repositories.speakers.sync([
      { conversationId: LID, mode: "listening", attendFrom: "2026-08-01T00:00:00Z" },
    ]);
    await database.repositories.identity.canonicalize(new Map([[LID, PN]]));
    const records = await database.repositories.speakers.current();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ conversationId: PN, mode: "listening" });
  });
});
