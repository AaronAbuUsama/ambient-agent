import { loadAppConfig } from "../app/config";
import { createAmbientProofHarness } from "../app/proof";
import { rigAllowlist, rigConfig } from "./rig";

/**
 * Offline replay proof on the rig: re-run the latest retained Conversation run
 * input through the current prompt with a stubbed sender. A live model call
 * happens; no WhatsApp connection is opened and no message can be sent. The
 * replay outcome is retained as a `conversation-replay-v1` evaluation against
 * the original run.
 */
const allowlist = rigAllowlist();
const config = rigConfig(loadAppConfig());

const harness = await createAmbientProofHarness(config, {});
try {
  let outcome: { decision: string; textLength: number } | undefined;
  let replayed: string | undefined;
  const failures: string[] = [];
  for (const conversationId of allowlist.peerChats) {
    try {
      outcome = await harness.replayConversationRun(conversationId);
      replayed = conversationId;
      break;
    } catch (error) {
      // Redacted: the chat id itself never enters output.
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (!outcome || !replayed) {
    throw new Error(`replay failed for every peer chat form: ${failures.join(" | ")}`);
  }
  console.info(
    JSON.stringify(
      {
        replayedLatestRunFor: "peer chat",
        decision: outcome.decision,
        textLength: outcome.textLength,
      },
      null,
      2,
    ),
  );
} finally {
  await harness.stop();
}
