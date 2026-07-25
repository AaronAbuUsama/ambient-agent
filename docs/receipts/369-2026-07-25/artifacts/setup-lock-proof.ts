/**
 * Tier-3 harness for #369 — the setup lock, driven as a real setup in a real OS process.
 *
 * Not a test double: it calls the shipped `installPreparedManagedData` through the same
 * test-support wrapper the suite uses, so the lock is taken by the real setup routine at the
 * real moment, and `kill -9` lands on a real process mid-setup.
 *
 *   tsx docs/receipts/369-2026-07-25/artifacts/setup-lock-proof.ts hold <root> <nonce>
 *   tsx docs/receipts/369-2026-07-25/artifacts/setup-lock-proof.ts run  <root> <nonce>
 *
 * `hold` stops inside prepare — the lock is held, setup is genuinely in flight — until the
 * sentinel file `<root>.go` appears, then finishes the install. That is where a browser-driven
 * setup sits while the operator is still filling the form, and where an interruption lands.
 * `run` performs an ordinary setup and reports whether it proceeded or was refused.
 *
 * Runs only against a scratch data directory. It never reads or writes ~/.ambient-agent, and
 * never copies a whatsapp/ store.
 */
import { basename, dirname, join } from "node:path";
import { mkdir, readFile, stat } from "node:fs/promises";
import { hostname } from "node:os";

import { createManagedChatGptCredentialStore } from "../../../../packages/engine/src/model/chatgpt-authentication.ts";
import { installManagedData } from "../../../../packages/test-support/src/managed-installation.ts";
import { managedPaths, type ManagedPaths } from "../../../../packages/installation/src/paths.ts";

const [mode, root, nonce] = process.argv.slice(2);
if ((mode !== "hold" && mode !== "run") || root === undefined || nonce === undefined) {
  throw new Error("usage: setup-lock-proof.ts <hold|run> <root> <nonce>");
}
if (root.includes(".ambient-agent") && !root.includes(nonce)) {
  throw new Error("refusing to run against a real managed data directory; pass a scratch root");
}

const lockPath = join(dirname(root), `.${basename(root)}.setup.lock`);
const sentinel = `${root}.go`;
const stamp = () => new Date().toISOString();
const say = (message: string) => process.stdout.write(`[${stamp()}] [${mode} pid=${process.pid}] ${message}\n`);

const exists = async (path: string) => await stat(path).then(() => true).catch(() => false);

const recordedOwner = async () => {
  try {
    return JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
  } catch (cause) {
    return { unreadable: (cause as NodeJS.ErrnoException).code ?? String(cause) };
  }
};

/** The setup credential step — and, in `hold` mode, where the run is interrupted. */
const authenticateChatGpt = async (paths: ManagedPaths): Promise<void> => {
  say(`setup is in flight; the lock at ${lockPath} now records:`);
  say(`  ${JSON.stringify(await recordedOwner())}`);
  if (mode === "hold") {
    say(`holding the lock until ${sentinel} appears (kill -9 me to interrupt this setup)`);
    while (!(await exists(sentinel))) await new Promise((resolve) => setTimeout(resolve, 100));
    say("sentinel seen; finishing the setup");
  }
  const store = createManagedChatGptCredentialStore({ path: paths.chatGptOAuthCredential });
  await store.modify("openai-codex", async () => ({
    type: "oauth" as const,
    access: "scratch-access",
    refresh: "scratch-refresh",
    expires: 2_000_000_000_000,
    accountId: `proof-${nonce}`,
  }));
};

say(`nonce=${nonce} host=${hostname()} root=${root}`);
await mkdir(dirname(root), { recursive: true, mode: 0o700 });

try {
  const result = await installManagedData({
    dataDirectory: root,
    managedChats: ["120363000@g.us"],
    defaultRepository: "AaronAbuUsama/ambient-agent",
    authenticateChatGpt,
  });
  say(`SETUP PROCEEDED: created=${result.created} state=${result.inspection.state} at ${result.inspection.dataDirectory}`);
} catch (cause) {
  say(`SETUP REFUSED: ${(cause as Error).message}`);
  process.exitCode = 1;
}
