import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadAppConfig } from "../app/config";
import { muzzleLibsignalConsole } from "../platform/logging";
import { createWhatsAppPeer } from "../whatsapp/peer";
import { RIG_PRIVATE, rigAllowlist } from "./rig";

/**
 * Media, live, end to end: a real screenshot into the Tst group, and a real
 * GitHub issue carrying that screenshot back out.
 *
 * The caption is deliberately vague ("this is wrong again"). The screenshot
 * shows "Isha 22:21" and a negative countdown. So any specific detail in the
 * filed issue can ONLY have come from looking at the pixels — that is the
 * assertion, and it cannot be satisfied by a caption-reading system.
 *
 * MUTUAL EXCLUSION: the rig subject and the production deployment are the
 * SAME WhatsApp account on two linked devices — production must not run.
 *
 * The receipt carries statuses, counts, and issue numbers only.
 */

muzzleLibsignalConsole();

const run = promisify(execFile);
const HOME = `${RIG_PRIVATE}/android-home`;
const slug = "tst-media";
const SANDBOX = "AaronAbuUsama/ambient-worker-sandbox";
const SCREENSHOT = fileURLToPath(new URL("./fixtures/media-proof-screenshot.png", import.meta.url));
const allowlist = rigAllowlist();
const base = loadAppConfig();

const groupId = allowlist.groups[0];
if (!groupId) throw new Error("the allowlist names no test group");
const peerIds = new Set(allowlist.peerChats);

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

async function sandboxIssues(): Promise<readonly { number: number; body: string }[]> {
  const { stdout } = await run("gh", ["api", `repos/${SANDBOX}/issues?state=all&per_page=100`]);
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error("unexpected sandbox issue list shape");
  return parsed.map((issue) => {
    const record = issue as { number: number; body: string | null };
    return { number: record.number, body: record.body ?? "" };
  });
}

const peer = createWhatsAppPeer({
  accountId: "ios",
  dataDirectory: `${RIG_PRIVATE}/ios`,
  logLevel: base.logging.level,
});

const receipt: Record<string, unknown> = {};
const before = await sandboxIssues();
receipt.sandboxIssuesBefore = before.length;

mkdirSync(join(HOME, "agents", "github-issues"), { recursive: true });
writeFileSync(
  join(HOME, "agents", "github-issues", "agent.yaml"),
  [
    "description: Files well-written GitHub issues from conversation evidence.",
    "model: worker",
    "instructions: |",
    "  You are a careful bug reporter. File ONE issue for the objective: a specific title and a",
    "  body with what happened, expected behaviour, and any reproduction detail the objective",
    "  gives you. Quote exact values the objective states. Invent nothing beyond the objective.",
    "tools:",
    "  github_issues:",
    "    repositories:",
    `      - ${SANDBOX}`,
    "",
  ].join("\n"),
);
clearClaimants(groupId);
mkdirSync(join(HOME, "chats", slug), { recursive: true });
writeFileSync(
  join(HOME, "chats", slug, "mandate.yaml"),
  [
    `chatId: ${groupId}`,
    "mode: responding",
    "instructions: |",
    "  This is a live test thread for bug filing. When someone reports a bug — including one",
    "  shown in a screenshot — delegate filing it to the github-issues agent with a complete",
    "  self-contained objective that quotes the exact values you can see, and attach the",
    "  screenshot's ref as evidence. Briefly tell the chat what you set in motion. When a task",
    "  update arrives, report the issue number and its link. Keep replies short.",
    "agents:",
    "  github-issues:",
    "",
  ].join("\n"),
);

const { child, connected } = startDaemon();
try {
  await connected;
  receipt.daemonConnected = true;
  await peer.start();
  receipt.peerOnline = true;
  await settle(2_000);
  receipt.mandateApplied = daemonOutput.includes(`${slug}(responding)`);

  // Vague on purpose: everything specific must come from the pixels.
  await peer.sendImage(groupId, readFileSync(SCREENSHOT), "this is wrong again");
  await waitForLine(`→ ${slug}: message received`, 120_000);
  receipt.mediaRetainedLive = true;

  await waitForLine(`⇢ ${slug}: delegated to github-issues`, 300_000);
  receipt.delegated = true;
  await waitForLine(`⇠ ${slug}: worker github-issues succeeded`, 360_000);
  receipt.workerSucceeded = true;

  const report = await peer.waitForText(
    (message) =>
      message.chatId === groupId &&
      !peerIds.has(message.senderId) &&
      /#\d+|issues\/\d+/.test(message.text),
    480_000,
  );
  const reported = /(?:#|issues\/)(\d+)/.exec(report.text)?.[1];
  receipt.reportedInChat = true;
  receipt.reportedIssueNumber = Number(reported ?? "0");

  const after = await sandboxIssues();
  const fresh = after.filter(({ number }) => !before.some((issue) => issue.number === number));
  receipt.newIssues = fresh.length;
  if (fresh.length !== 1) throw new Error(`expected exactly 1 new issue, found ${fresh.length}`);
  const filed = fresh[0]!;

  receipt.newIssueCarriesMarker = filed.body.includes("Ambient-Task: conversation:");
  // The screenshot itself travelled: GitHub only mints this host for an
  // attachment that was actually uploaded and referenced.
  receipt.issueEmbedsScreenshot = filed.body.includes("user-attachments/assets");
  // The decisive one. The caption said "this is wrong again"; only something
  // that looked at the image knows what it showed.
  receipt.issueQuotesWhatOnlyVisionSaw = /22:21|00:14/.test(filed.body);
  receipt.reportMatchesIssue = String(filed.number) === String(reported ?? "");

  const failed = Object.entries(receipt).filter(([, value]) => value === false);
  if (failed.length > 0) {
    throw new Error(`media live proof failed: ${failed.map(([key]) => key).join(", ")}`);
  }
  receipt.verdict = "PASS";
} catch (error) {
  receipt.verdict = "FAIL";
  receipt.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  console.info(JSON.stringify(receipt, null, 2));
  await peer.stop().catch(() => {});
  if (child.exitCode === null) {
    child.kill("SIGINT");
    await new Promise((resolvePromise) => child.once("exit", resolvePromise));
  }
}
