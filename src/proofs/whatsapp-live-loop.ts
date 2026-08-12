import { readFileSync } from "node:fs";
import { z } from "zod";
import { loadAppConfig, type AppConfig } from "../app/config";
import { createAmbientProofHarness } from "../app/proof";
import { createWhatsAppPeer } from "../whatsapp/peer";

/**
 * Fully autonomous live loop between the two linked proof accounts.
 *
 * The `android` profile is the subject and runs the production composition
 * through the proof harness; the `ios` profile is the peer and plays the human
 * counterpart. The peer sends one text, the subject's Conversation Agent
 * claims it behind the speaker gate and replies live, and the loop passes only
 * when the reply is delivered back to the peer's own mirror.
 *
 * Safety, per the real-account testing runbook: sends resolve against the
 * private allowlist beside the profiles — a missing file means no sends — and
 * nothing derived from the profiles (numbers, ids, bodies) is printed or
 * committed. The receipt below is statuses, counts, and lengths only.
 */
const allowlistSchema = z.object({
  groups: z.array(z.string().min(1)),
  chats: z.array(z.string().min(1)),
  subjectChats: z.array(z.string().min(1)).min(1),
  peerChats: z.array(z.string().min(1)).min(1),
});

const PRIVATE = ".proof-private";
const allowlist = allowlistSchema.parse(
  JSON.parse(readFileSync(`${PRIVATE}/send-allowlist.json`, "utf8")),
);
const allowed = new Set([...allowlist.groups, ...allowlist.chats]);
const subjectChats = new Set(allowlist.subjectChats);
const peerChats = new Set(allowlist.peerChats);

const base = loadAppConfig();
const hasQwenKey = Boolean(process.env.QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY);
const config: AppConfig = {
  ...base,
  database: { url: `file:${PRIVATE}/android/ambient.db` },
  whatsapp: { ...base.whatsapp, accountId: "android", dataDirectory: `${PRIVATE}/android` },
  models: hasQwenKey
    ? base.models
    : {
        ...base.models,
        roles: {
          ...base.models.roles,
          conversation: {
            provider: "vibe",
            model: "claude-sonnet-4-6",
            thinking: "off",
            maxOutputTokens: 1024,
          },
        },
      },
};

const harness = await createAmbientProofHarness(config, {
  authorizeDestination: (conversationId) => allowed.has(conversationId),
  instructions:
    "This is a controlled live-loop test between two linked test accounts. " +
    "Reply once with a brief acknowledgement and repeat the loop token from the inbound message.",
});
const peer = createWhatsAppPeer({
  accountId: "ios",
  dataDirectory: `${PRIVATE}/ios`,
  logLevel: base.logging.level,
});

const receipt: Record<string, unknown> = { model: hasQwenKey ? "qwen" : "vibe" };
try {
  await harness.start();
  receipt.subjectOnline = true;
  await peer.start();
  receipt.peerOnline = true;

  const token = `loop-${crypto.randomUUID().slice(0, 8)}`;
  await peer.sendText(
    allowlist.subjectChats[0]!,
    `Automated live-loop check ${token}: please acknowledge.`,
  );
  receipt.pingSubmitted = true;

  const accepted = await harness.waitForAccepted(
    ({ conversationId }) => peerChats.has(conversationId),
    120_000,
  );
  receipt.inboundAccepted = true;

  await new Promise((resolvePromise) =>
    setTimeout(resolvePromise, config.conversation.scheduling.debounceMs + 250),
  );
  receipt.runOutcome = await harness.requestConversationRun(accepted.conversationId, 240_000);

  const run = await harness.evidence.latestRun(accepted.conversationId);
  if (!run) throw new Error("no conversation run evidence was retained");
  receipt.runStatus = run.status;
  if (run.error) receipt.runError = run.error;
  const calls = await harness.evidence.toolCalls(run.id);
  receipt.toolCalls = calls.map(({ toolName, outcome }) => ({ toolName, outcome }));
  receipt.sendReceiptRetained = calls.some(
    ({ toolName, outcome }) => toolName === "send_message" && outcome === "succeeded",
  );

  const reply = await peer.waitForText(
    (message) => subjectChats.has(message.chatId) && !peerChats.has(message.senderId),
    120_000,
  );
  receipt.replyDeliveredToPeer = true;
  receipt.replyLength = reply.text.length;
  receipt.replyEchoedToken = reply.text.includes(token);

  if (run.status !== "succeeded" || !receipt.sendReceiptRetained) {
    throw new Error("live loop did not produce a successful run with a send receipt");
  }
} finally {
  console.info(JSON.stringify(receipt, null, 2));
  await peer.stop().catch(() => {});
  await harness.stop().catch(() => {});
}
