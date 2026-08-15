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
 * The craft, live: does it ASK before it files?
 *
 * The first live media proof filed an issue from a screenshot captioned only
 * "this is wrong again" — a thin report, and the prompts were why: the chat
 * was told to delegate on sight, and the definition had no permission to
 * decline. This proves the fix, in two turns.
 *
 * Turn 1 — the same vague report. The bar is not met (no platform, and
 * "again" claims a history nobody established), so the speaker must ask and
 * must NOT file. Nothing appearing in either repository is the assertion.
 *
 * Turn 2 — the answers, including which repository. Now it files, into the
 * repository it was told, carrying the screenshot.
 *
 * Two repositories are in the ceiling precisely so routing cannot be skipped
 * by there being only one candidate.
 *
 * MUTUAL EXCLUSION: the rig subject and production are the SAME WhatsApp
 * account on two linked devices — production must not run.
 */

muzzleLibsignalConsole();

const run = promisify(execFile);
const HOME = `${RIG_PRIVATE}/android-home`;
const slug = "tst-intake";
const REPOS = ["AaronAbuUsama/ambient-worker-sandbox", "AaronAbuUsama/wa-bot-sandbox"] as const;
const CHOSEN = REPOS[1];
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

/**
 * Forget this chat's retained thread before the run.
 *
 * The experiment is "given an underspecified report AND no prior answers,
 * does it ask?" — and a previous run of this proof leaves its own answers in
 * the thread, which the skill correctly tells the speaker to go and find. One
 * run of this proof genuinely filed on turn 1 for exactly that reason: it had
 * read last run's "Android, new build, first time today" and the bar really
 * was met. Isolating the run is the control, not a cover-up.
 */
async function forgetChat(): Promise<void> {
  const database = `${RIG_PRIVATE}/android/ambient.db`;
  await run("sqlite3", [
    database,
    `DELETE FROM conversation_inbox WHERE conversation_id = '${groupId}';` +
      `DELETE FROM claim_evidence WHERE observation_id IN ` +
      `(SELECT id FROM observations WHERE conversation_id = '${groupId}');` +
      `DELETE FROM episode_observations WHERE observation_id IN ` +
      `(SELECT id FROM observations WHERE conversation_id = '${groupId}');` +
      `DELETE FROM observations WHERE conversation_id = '${groupId}';`,
  ]);
}

async function issueNumbers(repository: string): Promise<readonly number[]> {
  const { stdout } = await run("gh", ["api", `repos/${repository}/issues?state=all&per_page=100`]);
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error("unexpected issue list shape");
  return parsed.map((issue) => (issue as { number: number }).number);
}

async function issueBody(repository: string, number: number): Promise<string> {
  const { stdout } = await run("gh", ["api", `repos/${repository}/issues/${number}`]);
  return (JSON.parse(stdout) as { body: string | null }).body ?? "";
}

const peer = createWhatsAppPeer({
  accountId: "ios",
  dataDirectory: `${RIG_PRIVATE}/ios`,
  logLevel: base.logging.level,
});

const receipt: Record<string, unknown> = {};
await forgetChat();
const before = Object.fromEntries(
  await Promise.all(REPOS.map(async (repo) => [repo, await issueNumbers(repo)] as const)),
);

// The Root's authorship: the real definition's bar, and a ceiling with two
// candidates so the repository cannot be chosen by default.
mkdirSync(join(HOME, "agents", "github-issues"), { recursive: true });
writeFileSync(
  join(HOME, "agents", "github-issues", "agent.yaml"),
  readFileSync(`${process.env.HOME}/.ambient/agents/github-issues/agent.yaml`, "utf8").replace(
    /repositories:[\s\S]*$/,
    ["repositories:", ...REPOS.map((repo) => `      - ${repo}`), ""].join("\n"),
  ),
);

clearClaimants(groupId);
mkdirSync(join(HOME, "chats", slug, "skills", "bug-intake"), { recursive: true });
// The real skill, verbatim: proving the copy in production, not a rehearsal of it.
writeFileSync(
  join(HOME, "chats", slug, "skills", "bug-intake", "SKILL.md"),
  readFileSync(`${process.env.HOME}/.ambient/chats/bug-reports/skills/bug-intake/SKILL.md`, "utf8"),
);
writeFileSync(
  join(HOME, "chats", slug, "mandate.yaml"),
  [
    `chatId: ${groupId}`,
    "mode: responding",
    "instructions: |",
    "  This is the bug thread for a prayer-times app shipping on iOS and Android. Reports arrive",
    "  in passing, often as a screenshot with a few words. Two builds run side by side and behave",
    "  differently, so platform matters in almost every report. Follow the bug-intake skill: ask",
    "  before filing, and never claim an issue exists before one does.",
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
  receipt.skillLoaded = !daemonOutput.includes("bug-intake(BROKEN)");

  // TURN 1 — the same vague report that produced a thin issue before.
  await peer.sendImage(groupId, readFileSync(SCREENSHOT), "this is wrong again");
  const asked = await peer.waitForText(
    (message) => message.chatId === groupId && !peerIds.has(message.senderId),
    420_000,
  );
  receipt.repliedToVagueReport = true;
  receipt.replyAsksSomething = asked.text.includes("?");
  // The two things the report never established.
  receipt.asksPlatformOrHistory = /android|ios|platform|before|first|previous|last time/i.test(
    asked.text,
  );
  receipt.replyLength = asked.text.length;

  // Nothing may have been filed on a report that did not meet the bar.
  await settle(20_000);
  const midway = Object.fromEntries(
    await Promise.all(REPOS.map(async (repo) => [repo, await issueNumbers(repo)] as const)),
  );
  receipt.filedNothingYet = REPOS.every((repo) => midway[repo]!.length === before[repo]!.length);
  if (!receipt.filedNothingYet) throw new Error("it filed an issue on an underspecified report");

  // TURN 2 — the answers, including the repository.
  await peer.sendText(
    groupId,
    `Android only, on the new build. It has never done this before — first time today. ` +
      `Expected the countdown to roll over to the next prayer instead of going negative. ` +
      `File it in ${CHOSEN}.`,
  );
  await peer.waitForText(
    (message) =>
      message.chatId === groupId &&
      !peerIds.has(message.senderId) &&
      /#\d+|issues\/\d+/.test(message.text),
    600_000,
  );
  receipt.reportedAfterAnswers = true;

  const after = Object.fromEntries(
    await Promise.all(REPOS.map(async (repo) => [repo, await issueNumbers(repo)] as const)),
  );
  const fresh = Object.fromEntries(
    REPOS.map((repo) => [repo, after[repo]!.filter((n) => !before[repo]!.includes(n))]),
  );
  receipt.newIssuesByRepository = Object.fromEntries(
    REPOS.map((repo) => [repo, fresh[repo]!.length]),
  );
  // Routed where it was told, and nowhere else.
  receipt.filedIntoTheNamedRepository = fresh[CHOSEN]!.length === 1;
  receipt.filedNowhereElse = REPOS.filter((repo) => repo !== CHOSEN).every(
    (repo) => fresh[repo]!.length === 0,
  );
  if (!receipt.filedIntoTheNamedRepository) {
    throw new Error("the issue did not land in the repository it was told to use");
  }

  const body = await issueBody(CHOSEN, fresh[CHOSEN]![0]!);
  receipt.issueNumber = fresh[CHOSEN]![0];
  receipt.issueEmbedsScreenshot = body.includes("user-attachments/assets");
  receipt.issueQuotesWhatOnlyVisionSaw = /22:21|00:14/.test(body);
  receipt.issueNamesThePlatform = /android/i.test(body);

  const failed = Object.entries(receipt).filter(([, value]) => value === false);
  if (failed.length > 0) {
    throw new Error(`intake proof failed: ${failed.map(([key]) => key).join(", ")}`);
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
