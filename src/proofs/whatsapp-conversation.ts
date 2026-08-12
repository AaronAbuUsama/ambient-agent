import { loadAppConfig } from "../app/config";
import { createAmbientProofHarness } from "../app/proof";

const targetHint = process.env.PROOF_WHATSAPP_TARGET_HINT?.trim().toLocaleLowerCase();
if (!targetHint) {
  throw new Error("PROOF_WHATSAPP_TARGET_HINT must identify the authorized test group or +44 chat");
}

const config = loadAppConfig();

let authorizedTargetId: string | undefined;
// Composing with authorizeDestination requires model credentials up front and
// refuses any send whose resolved destination is not the matched target.
const harness = await createAmbientProofHarness(config, {
  authorizeDestination: (conversationId) => conversationId === authorizedTargetId,
  instructions:
    "This is a controlled Ambient Phase 2B proof. Reply once with a brief acknowledgement.",
});

try {
  await harness.start();
  const candidates = harness
    .destinations()
    .filter(({ id, label }) => `${label} ${id}`.toLocaleLowerCase().includes(targetHint));
  if (candidates.length !== 1) {
    throw new Error(
      `proof target hint matched ${candidates.length} chats; use a unique test-group name or +44 identifier`,
    );
  }
  const target = candidates[0]!;
  authorizedTargetId = target.id;
  console.info(`Authorized proof target: ${target.label} (${target.id})`);
  console.info("Send one new inbound text message in that chat now.");

  const observed = await harness.waitForAccepted(
    ({ conversationId }) => conversationId === target.id,
    180_000,
  );
  await new Promise((resolve) => setTimeout(resolve, config.conversation.scheduling.debounceMs));
  await harness.requestConversationRun(target.id, 180_000);

  const run = await harness.evidence.latestRun(target.id);
  if (!run) throw new Error("no conversation run evidence was retained");
  const calls = await harness.evidence.toolCalls(run.id);
  const [evaluation] = await harness.evidence.evaluations(run.id);

  console.info(
    JSON.stringify(
      {
        target,
        observationId: observed.observationId,
        conversationId: observed.conversationId,
        run: { id: run.id, status: run.status, error: run.error },
        tools: calls.map(({ toolName, outcome: toolOutcome, output, error }) => ({
          toolName,
          outcome: toolOutcome,
          output,
          error,
        })),
        evaluationId: evaluation?.id,
      },
      null,
      2,
    ),
  );
  if (run.status !== "succeeded") throw new Error(run.error ?? "Conversation run failed");
} finally {
  await harness.stop();
}
