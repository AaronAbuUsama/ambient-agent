import { loadAppConfig } from "../app/config";
import { assistantText } from "../models/assistant-text";
import { createModelRuntime } from "../models/runtime";
import { messageOf } from "../platform/errors";

/**
 * Live model-runtime proof: resolve every configured role from the structured
 * configuration document and run one bounded prompt against each provider.
 * Requires real credentials (and a running local server for keyless
 * providers); performs no WhatsApp activity.
 */
const config = loadAppConfig();
const runtime = createModelRuntime(config.models);
if (runtime.roles.length === 0) throw new Error("no model roles are configured");

let failed = false;
for (const role of runtime.roles) {
  const runner = runtime.forRole(role);
  const label = `${role} -> ${runner.snapshot.provider}/${runner.snapshot.model}`;
  try {
    const message = await runner
      .stream({
        messages: [
          {
            role: "user",
            content: 'This is an Ambient model-runtime proof. Reply with exactly "OK".',
            timestamp: Date.now(),
          },
        ],
      })
      .result();
    const text = assistantText(message);
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      failed = true;
      console.error(`${label}: ${message.stopReason}: ${message.errorMessage ?? "unknown"}`);
    } else {
      console.info(`${label}: ${JSON.stringify(text)}`);
    }
  } catch (error) {
    failed = true;
    console.error(`${label}: ${messageOf(error)}`);
  }
}
if (failed) throw new Error("model runtime proof failed");
