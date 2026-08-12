import { loadAppConfig } from "../app/config";
import { createAmbientProofHarness } from "../app/proof";

const config = loadAppConfig();
// No authorizeDestination: a listen-only harness that cannot send at all.
const harness = await createAmbientProofHarness(config);

try {
  await harness.start();
  console.info(
    `Listening on WhatsApp account "${config.whatsapp.accountId}". Send one new text message to the linked account.`,
  );
  const result = await harness.waitForAccepted(() => true, 120_000);
  console.info(
    `Retained Observation "${result.observationId}" for conversation "${result.conversationId}". No outbound message was sent.`,
  );
} finally {
  await harness.stop();
}
