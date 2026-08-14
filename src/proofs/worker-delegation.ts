import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAppConfig, type AppConfig } from "../app/config";
import { createAmbientProofHarness } from "../app/proof";
import type { GhCommand } from "../github/issues";

/**
 * Offline delegation rehearsal: the production composition with a synthetic
 * home, a synthetic chat, a live model, and a fake `gh` that CANNOT reach
 * GitHub. Walks the whole chain — grant on disk, bug report in, speaker
 * delegates, worker files, receipt retained, task update returns, speaker
 * consumes it — then proves a revoked grant strips the capability without a
 * restart. No WhatsApp connection is opened and nothing can be sent. The
 * receipt carries statuses, counts, and argument shapes only.
 */

const CHAT_ID = "240100000000000001@g.us";
const REPORTER = "15550000001@s.whatsapp.net";
const REPOSITORY = "rehearsal/sandbox";

const rehearsalInstructions = `REHEARSAL RULES (they override everything else):
- NEVER call send_message; the channel is offline in this rehearsal.
- When a message reports a concrete software bug and you can delegate, call delegate exactly once
  with agent "github-issues" and a complete self-contained objective describing the bug.
- If you cannot delegate (no agents available), do nothing and finish with a short summary.
- When your input contains a task update, do not send anything; finish with a summary
  acknowledging the outcome.`;

function fakeGh() {
  const calls: string[][] = [];
  const issues: { number: number; html_url: string; body: string }[] = [];
  let next = 100;
  const gh: GhCommand = (args) => {
    calls.push([...args]);
    if (args[0] === "api") return Promise.resolve(JSON.stringify(issues));
    const repo = args[args.indexOf("--repo") + 1] ?? "rehearsal/unknown";
    const body = args[args.indexOf("--body") + 1] ?? "";
    const number = next++;
    const url = `https://github.com/${repo}/issues/${number}`;
    issues.push({ number, html_url: url, body });
    return Promise.resolve(`${url}\n`);
  };
  return { gh, calls, issues };
}

function writeHome(home: string, options: { readonly granted: boolean }): void {
  mkdirSync(join(home, "chats", "rehearsal"), { recursive: true });
  mkdirSync(join(home, "agents", "github-issues"), { recursive: true });
  writeFileSync(
    join(home, "chats", "rehearsal", "mandate.yaml"),
    [
      `chatId: ${CHAT_ID}`,
      "mode: responding",
      ...(options.granted ? ["agents:", "  github-issues:"] : []),
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(home, "agents", "github-issues", "agent.yaml"),
    [
      "description: Files well-written GitHub issues from conversation evidence.",
      "model: worker",
      "instructions: |",
      "  You are a careful bug reporter. File ONE issue for the objective: a specific title and a",
      "  body with what happened, expected behaviour, and any reproduction detail the objective",
      "  gives you. Invent nothing.",
      "tools:",
      "  github_issues:",
      "    repositories:",
      `      - ${REPOSITORY}`,
      "",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "ambient-worker-rehearsal-"));
  const receipt: Record<string, unknown> = {};
  const { gh, calls, issues } = fakeGh();
  try {
    const home = join(scratch, "home");
    writeHome(home, { granted: true });
    const base = loadAppConfig();
    const config: AppConfig = {
      ...base,
      home,
      database: { url: `file:${join(scratch, "rehearsal.db")}` },
      whatsapp: {
        ...base.whatsapp,
        accountId: "rehearsal",
        dataDirectory: join(scratch, "wa"),
      },
      models: {
        ...base.models,
        roles: {
          ...base.models.roles,
          conversation: {
            provider: "vibe",
            model: "gpt-5.6-terra",
            thinking: "off",
            maxOutputTokens: 2048,
          },
        },
      },
    };

    const harness = await createAmbientProofHarness(config, {
      // Belt and braces: the model is told not to send, and every resolved
      // destination is refused anyway.
      authorizeDestination: () => false,
      instructions: rehearsalInstructions,
      gh,
    });
    try {
      await harness.watchPolicy();

      // 1. A bug report arrives; the speaker should delegate, silently.
      await harness.injectAccepted({
        conversationId: CHAT_ID,
        senderId: REPORTER,
        senderName: "Rehearsal Reporter",
        text: "Bug: exporting a report as PDF crashes the app when the report has zero rows. Expected an empty PDF. Happens every time on version 2.3.1.",
      });
      const delegatingRun = await harness.requestConversationRun(CHAT_ID, 180_000);
      receipt["delegatingRun"] = delegatingRun;
      if (delegatingRun !== "succeeded") throw new Error("delegating run failed");

      const opened = await harness.assignments(CHAT_ID);
      receipt["opened"] = opened.map(({ status, workerProfile, target }) => ({
        status,
        workerProfile,
        target,
      }));
      if (opened.length !== 1) throw new Error(`expected 1 assignment, found ${opened.length}`);
      const assignment = opened[0]!;
      if (assignment.status !== "queued") throw new Error("assignment is not queued");
      if (assignment.workerProfile !== "github-issues") throw new Error("wrong worker profile");
      if (assignment.target !== REPOSITORY) throw new Error("wrong target repository");
      if (!assignment.id.includes(":delegate")) {
        throw new Error("assignment id is not derived from the delegating claim");
      }

      // 2. The worker drains it against the fake gh.
      const workerRun = await harness.requestWorkerRun(180_000);
      receipt["workerRun"] = workerRun;
      if (workerRun.outcome !== "done") throw new Error("worker run failed");

      const done = (await harness.assignments(CHAT_ID))[0]!;
      receipt["completed"] = {
        status: done.status,
        artifactTitles: done.artifactTitles,
        resultSummaryLength: done.resultSummaryLength,
      };
      if (done.status !== "succeeded") throw new Error("assignment did not succeed");
      if (!done.artifactTitles.includes("issue")) throw new Error("no issue receipt retained");

      const creates = calls.filter((args) => args.includes("create"));
      receipt["gh"] = {
        calls: calls.length,
        creates: creates.length,
        issues: issues.length,
      };
      if (creates.length !== 1) throw new Error(`expected 1 gh create, saw ${creates.length}`);
      const create = creates[0]!;
      if (create[create.indexOf("--repo") + 1] !== REPOSITORY) {
        throw new Error("issue filed outside the assigned repository");
      }
      if (!create[create.indexOf("--body") + 1]?.includes(`Ambient-Task: ${assignment.id}`)) {
        throw new Error("issue body does not carry the assignment marker");
      }

      // 3. The result returns: the speaker's next run consumes the task update.
      const reportingRun = await harness.requestConversationRun(CHAT_ID, 180_000);
      const consumedKinds = await harness.latestRunInboxKinds(CHAT_ID);
      receipt["reportingRun"] = { outcome: reportingRun, consumedKinds };
      if (reportingRun !== "succeeded") throw new Error("reporting run failed");
      if (!consumedKinds.includes("task_update")) {
        throw new Error("the reporting run did not consume the task update");
      }

      // 4. Revocation without a restart: the grant disappears from disk, and
      //    with it the capability — no new assignment for a new bug report.
      writeHome(home, { granted: false });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1500));
      await harness.injectAccepted({
        conversationId: CHAT_ID,
        senderId: REPORTER,
        senderName: "Rehearsal Reporter",
        text: "Bug: the settings screen shows a blank page after logout. Expected the login form.",
      });
      const revokedRun = await harness.requestConversationRun(CHAT_ID, 180_000);
      const afterRevocation = await harness.assignments(CHAT_ID);
      receipt["revocation"] = {
        outcome: revokedRun,
        assignments: afterRevocation.length,
      };
      if (revokedRun !== "succeeded") throw new Error("post-revocation run failed");
      if (afterRevocation.length !== 1) {
        throw new Error("a revoked grant still produced an assignment");
      }

      receipt["verdict"] = "PASS";
    } finally {
      await harness.stop();
    }
  } catch (error) {
    receipt["verdict"] = "FAIL";
    receipt["error"] = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    console.info(JSON.stringify(receipt, null, 2));
  }
}

await main();
