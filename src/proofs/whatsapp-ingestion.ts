import { loadAppConfig } from "../app/config";
import { createAppResources } from "../app/resources";

const config = loadAppConfig();
const retained = Promise.withResolvers<{
  readonly observationId: string;
  readonly conversationId: string;
}>();
const { database, whatsapp } = await createAppResources(config, (message) => {
  retained.resolve(message);
});

const timeout = AbortSignal.timeout(120_000);
const timedOut = new Promise<never>((_, reject) => {
  timeout.addEventListener(
    "abort",
    () => reject(new Error("No new inbound text message arrived within 120 seconds")),
    { once: true },
  );
});

try {
  await whatsapp.attach();
  console.info(
    `Listening on WhatsApp account "${config.whatsapp.accountId}". Send one new text message to the linked account.`,
  );
  const result = await Promise.race([retained.promise, timedOut]);
  console.info(
    `Retained Observation "${result.observationId}" for conversation "${result.conversationId}". No outbound message was sent.`,
  );
} finally {
  await whatsapp.dispose();
  await database.close();
}
