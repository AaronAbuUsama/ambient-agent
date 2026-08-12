import { loadAppConfig } from "../app/config";
import { createAmbientProofHarness } from "../app/proof";
import { createWhatsAppPeer } from "../whatsapp/peer";
import { RIG_PRIVATE, rigAllowlist, rigConfig } from "./rig";

/**
 * Fully autonomous live loop between the two linked proof accounts.
 *
 * The `android` profile is the subject and runs the production composition
 * through the proof harness; the `ios` profile is the peer and plays the human
 * counterpart. The peer sends one text, the subject's Conversation Agent
 * claims it behind the speaker gate and replies live, the reply must land in
 * the peer's own mirror, and the asynchronous evaluation runner then judges
 * the retained run. The receipt is statuses, counts, and lengths only.
 */
const allowlist = rigAllowlist();
const allowed = new Set([...allowlist.groups, ...allowlist.chats]);
const subjectChats = new Set(allowlist.subjectChats);
const peerChats = new Set(allowlist.peerChats);

const base = loadAppConfig();
const config = rigConfig(base);

const harness = await createAmbientProofHarness(config, {
  authorizeDestination: (conversationId) => allowed.has(conversationId),
  instructions:
    "This is a controlled live-loop test between two linked test accounts. " +
    "Reply once with a brief acknowledgement and repeat the loop token from the inbound message.",
});
const peer = createWhatsAppPeer({
  accountId: "ios",
  dataDirectory: `${RIG_PRIVATE}/ios`,
  logLevel: base.logging.level,
});

const receipt: Record<string, unknown> = {
  model: config.models.roles.conversation?.provider,
};
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

  let evaluationsProcessed = 0;
  while ((await harness.runEvaluationsOnce()) === "processed") evaluationsProcessed += 1;
  receipt.evaluationsProcessed = evaluationsProcessed;
  const evaluations = await harness.evidence.evaluations(run.id);
  receipt.evaluationCases = evaluations.map(({ caseId, status }) => ({ caseId, status }));

  if (run.status !== "succeeded" || !receipt.sendReceiptRetained) {
    throw new Error("live loop did not produce a successful run with a send receipt");
  }
  if (
    !evaluations.some(
      ({ caseId, status }) => caseId.startsWith("conversation-contract") && status === "succeeded",
    )
  ) {
    throw new Error("live loop did not retain a successful contract evaluation");
  }
} finally {
  console.info(JSON.stringify(receipt, null, 2));
  await peer.stop().catch(() => {});
  await harness.stop().catch(() => {});
}
