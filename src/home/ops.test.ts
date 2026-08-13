import { expect, test } from "vite-plus/test";
import { createClient } from "@libsql/client";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAmbientDatabase } from "../database/database";
import { initHome } from "./init";
import { activateChat, setMaster } from "./ops";

const configYaml = [
  "# deployment document",
  "account: main",
  "providers:",
  "  local:",
  "    adapter: openai-compatible",
  "    baseUrl: http://127.0.0.1:9999/v1",
  "    credential: none",
  "roles:",
  "  conversation: { provider: local, model: test-model }",
].join("\n");

async function withHome(work: (home: string, env: NodeJS.ProcessEnv) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "ambient-ops-"));
  try {
    initHome(home);
    await writeFile(join(home, "config.yaml"), configYaml);
    const mirror = createClient({ url: `file:${join(home, "state", "whatsapp.db")}` });
    await mirror.execute(
      "CREATE TABLE wa_chats (account_id TEXT, chat_id TEXT, data_json TEXT, PRIMARY KEY (account_id, chat_id))",
    );
    const chats = [
      ["main", "111@g.us", '{"subject":"Bug Reports"}'],
      ["main", "222@g.us", '{"subject":"Family Group"}'],
      ["main", "333@g.us", '{"subject":"Family Reunion"}'],
      ["other", "999@g.us", '{"subject":"Bug Reports"}'],
    ];
    for (const [account, chatId, data] of chats) {
      await mirror.execute({
        sql: "INSERT INTO wa_chats VALUES (?, ?, ?)",
        args: [account ?? "", chatId ?? "", data ?? ""],
      });
    }
    await mirror.execute(
      "CREATE TABLE wa_contact_aliases (account_id TEXT, native_id TEXT, contact_id TEXT, PRIMARY KEY (account_id, native_id))",
    );
    await mirror.execute(
      "INSERT INTO wa_contact_aliases VALUES ('main', '555@lid', '447700900123@s.whatsapp.net')",
    );
    mirror.close();
    await work(home, { AMBIENT_HOME: home });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("activate by name writes the minimum mandate and syncs the record", async () => {
  await withHome(async (home, env) => {
    const result = await activateChat(env, "bug rep", "listening");
    expect(result).toEqual({ kind: "activated", slug: "bug-reports", mode: "listening" });
    const mandate = await readFile(join(home, "chats", "bug-reports", "mandate.yaml"), "utf8");
    expect(mandate).toContain("chatId: 111@g.us");
    // Every field is present: granted ones real, defaults as comments.
    expect(mandate).toContain("# mode: responding");
    expect(mandate).toContain("# instructions:");
    expect(mandate).toContain("# memoryBrief:");
    expect(mandate).not.toContain("master's direct line");

    const database = await openAmbientDatabase(`file:${join(home, "state", "ambient.db")}`);
    try {
      const records = await database.repositories.speakers.current();
      expect(records).toMatchObject([{ conversationId: "111@g.us", mode: "listening" }]);
    } finally {
      await database.close();
    }
  });
});

test("activate --responding writes the mode and gates on ambiguity", async () => {
  await withHome(async (home, env) => {
    expect(await activateChat(env, "family", "responding")).toEqual({
      kind: "ambiguous",
      candidates: ["Family Group", "Family Reunion"],
    });
    const result = await activateChat(env, "family gr", "responding");
    expect(result).toEqual({ kind: "activated", slug: "family-group", mode: "responding" });
    const mandate = await readFile(join(home, "chats", "family-group", "mandate.yaml"), "utf8");
    expect(mandate).toContain("mode: responding");

    const database = await openAmbientDatabase(`file:${join(home, "state", "ambient.db")}`);
    try {
      expect(await database.repositories.speakers.isResponding("222@g.us")).toBe(true);
    } finally {
      await database.close();
    }
  });
});

test("activate resolves phone numbers, exact ids, and reports the unknown", async () => {
  await withHome(async (home, env) => {
    const byNumber = await activateChat(env, "+44 7700 900123", "listening");
    expect(byNumber).toEqual({ kind: "activated", slug: "447700900123", mode: "listening" });
    const mandate = await readFile(join(home, "chats", "447700900123", "mandate.yaml"), "utf8");
    expect(mandate).toContain("chatId: 447700900123@s.whatsapp.net");

    // One human, one conversation: the lid identity form resolves to the SAME
    // canonical chat the phone number already activated.
    expect(await activateChat(env, "555@lid", "listening")).toEqual({
      kind: "already-active",
      slug: "447700900123",
    });

    expect(await activateChat(env, "no such chat", "listening")).toEqual({
      kind: "not-found",
      query: "no such chat",
    });
    expect(await activateChat(env, "bug reports", "listening")).toMatchObject({
      kind: "activated",
    });
    expect(await activateChat(env, "111@g.us", "listening")).toEqual({
      kind: "already-active",
      slug: "bug-reports",
    });
  });
});

test("activating the master's chat marks the file as the Root's seat", async () => {
  await withHome(async (home, env) => {
    await writeFile(join(home, "config.yaml"), `master: { chatId: 111@g.us }\n${configYaml}`);
    const result = await activateChat(env, "bug reports", "responding");
    expect(result).toMatchObject({ kind: "activated" });
    const mandate = await readFile(join(home, "chats", "bug-reports", "mandate.yaml"), "utf8");
    expect(mandate).toContain("master's direct line");
    expect(mandate).toContain("mode: responding # remove to return to listening");
  });
});

test("setMaster derives the chat id and preserves config comments", async () => {
  await withHome(async (home, env) => {
    const { chatId } = setMaster(env, "+971 58 570 0055");
    expect(chatId).toBe("971585700055@s.whatsapp.net");
    const config = await readFile(join(home, "config.yaml"), "utf8");
    expect(config).toContain("# deployment document");
    expect(config).toContain("chatId: 971585700055@s.whatsapp.net");
    expect(existsSync(join(home, "chats", "971585700055"))).toBe(false);
  });
});
