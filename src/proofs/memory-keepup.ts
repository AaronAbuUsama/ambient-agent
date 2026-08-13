import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAppConfig } from "../app/config";
import { createWhatsAppPeer } from "../whatsapp/peer";
import { RIG_PRIVATE, rigAllowlist } from "./rig";

/**
 * Memory keeping up, live, against the RUNNING daemon — the other half of the
 * digest proof, which catches up on retained history through the stepped
 * harness. Here a real WhatsApp message arrives while Ambient is running and
 * the daemon digests it on its own: no proof stepping, no human.
 *
 * MUTUAL EXCLUSION: the rig subject and the production deployment are the
 * SAME WhatsApp account on two linked devices — stop production first.
 *
 * The journey:
 *
 *   1. a listening mandate with a memory brief   -> the chat is memory-only
 *   2. the peer sends one real message carrying a durable fact
 *   3. the daemon retains it, the backlog goes quiet, and the window digests
 *   4. the daemon narrates the digest in its own voice
 *
 * Listening mode is the point: memory is default-on presence, so nothing is
 * ever sent back. The receipt carries statuses, counts, and booleans only.
 */

const HOME = `${RIG_PRIVATE}/android-home`;
const slug = "keepup";
const allowlist = rigAllowlist();
const base = loadAppConfig();

// The quiet window a small backlog waits out before it is due (service
// default), plus the poll interval and one digest — generously bounded.
const QUIET_MS = 300_000;
const DIGEST_TIMEOUT_MS = QUIET_MS + 240_000;

let daemonOutput = "";

function startDaemon(): { child: ChildProcess; connected: Promise<void> } {
  const environment: NodeJS.ProcessEnv = { ...process.env, AMBIENT_HOME: HOME };
  delete environment.AMBIENT_CONFIG;
  const child = spawn("pnpm", ["exec", "tsx", "src/cli.ts"], {
    env: environment,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const connected = new Promise<void>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error("daemon never connected")), 90_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      daemonOutput += chunk.toString();
      if (daemonOutput.includes("ambient online")) {
        clearTimeout(timer);
        resolvePromise();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      rejectPromise(new Error(`daemon exited early (code ${String(code)})`));
    });
  });
  return { child, connected };
}

/** Resolves when the daemon prints a line, or rejects on timeout. */
function waitForLine(contains: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise, rejectPromise) => {
    const tick = setInterval(() => {
      if (daemonOutput.includes(contains)) {
        clearInterval(tick);
        resolvePromise();
      } else if (Date.now() > deadline) {
        clearInterval(tick);
        rejectPromise(new Error(`daemon never printed "${contains}"`));
      }
    }, 2_000);
  });
}

const settle = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

const peer = createWhatsAppPeer({
  accountId: "ios",
  dataDirectory: `${RIG_PRIVATE}/ios`,
  logLevel: base.logging.level,
});

/**
 * Two folders claiming one chat id make BOTH inert — the projector fails
 * closed and reports each as broken. A previous proof's mandate for this same
 * peer chat would therefore silence this one, so clear the claimants first.
 */
function clearClaimants(chatId: string): void {
  const chats = join(HOME, "chats");
  for (const folder of readdirSync(chats, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    const path = join(chats, folder.name, "mandate.yaml");
    const mandate = (() => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return "";
      }
    })();
    if (mandate.includes(chatId))
      rmSync(join(chats, folder.name), { recursive: true, force: true });
  }
}

const receipt: Record<string, unknown> = {};
const { child, connected } = startDaemon();
try {
  await connected;
  receipt.daemonConnected = true;
  await peer.start();
  receipt.peerOnline = true;

  // Listening: memory runs, the speaker never does. The brief is what this
  // chat's memory is FOR — the same mandate field the digest proof exercises.
  const canonicalForm =
    allowlist.peerChats.find((chatId) => chatId.endsWith("@s.whatsapp.net")) ??
    allowlist.peerChats[0]!;
  clearClaimants(canonicalForm);
  mkdirSync(join(HOME, "chats", slug), { recursive: true });
  writeFileSync(
    join(HOME, "chats", slug, "mandate.yaml"),
    [
      `chatId: ${canonicalForm}`,
      "mode: listening",
      "memoryBrief: |",
      "  A product working thread. Remember the product's stable facts, the bugs people",
      "  report with their platform and status, and who owns what.",
      "",
    ].join("\n"),
  );
  await settle(2_000);
  receipt.mandateApplied = daemonOutput.includes(`${slug}(listening)`);

  // One real message carrying a durable, checkable fact.
  const token = crypto.randomUUID().slice(0, 6);
  await peer.sendText(
    allowlist.subjectChats[0]!,
    `Keep-up ${token}: the Ambient dashboard build ${token} crashes on Android when opening ` +
      `the settings page. Filing it against the ambient-agent repository.`,
  );
  await waitForLine(`→ ${slug}: message received`, 60_000);
  receipt.messageRetained = true;

  // The daemon's own loop: quiet backlog becomes due, the window digests, and
  // the daemon says so. Nothing here steps the service.
  await waitForLine(`~ ${slug}: memory digested`, DIGEST_TIMEOUT_MS);
  receipt.memoryDigestedLive = true;
  const digestLine = daemonOutput
    .split("\n")
    .find((line) => line.includes(`~ ${slug}: memory digested`));
  receipt.digestClaimCount = Number(/\((\d+) claims\)/.exec(digestLine ?? "")?.[1] ?? "0");
  receipt.digestCarriedClaims = (receipt.digestClaimCount as number) > 0;

  // Listening never speaks: no reply may have gone out for this chat.
  receipt.stayedSilent = !daemonOutput.includes(`← ${slug}: reply sent`);

  const failed = Object.entries(receipt).filter(([, value]) => value === false);
  if (failed.length > 0) {
    throw new Error(`keep-up failed: ${failed.map(([key]) => key).join(", ")}`);
  }
} finally {
  console.info(JSON.stringify(receipt, null, 2));
  await peer.stop().catch(() => {});
  if (child.exitCode === null) {
    child.kill("SIGINT");
    await new Promise((resolvePromise) => child.once("exit", resolvePromise));
  }
}
