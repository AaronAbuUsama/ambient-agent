/**
 * Open a real WhatsApp session over the libSQL deployment and prove a pairing
 * challenge arrives.
 *
 * @remarks
 * Reaching `pairing/challenge_live` means the WebSocket opened, the Noise
 * handshake completed, and WhatsApp itself issued the payload — everything up
 * to the human holding a phone. The QR is printed so that human can finish the
 * job; scanning is the one step no test can perform.
 *
 * ```bash
 * bun run prove:pairing               # a throwaway account directory
 * WHATSAPP_DATA_DIR=./data bun run prove:pairing   # the real one
 * ```
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WhatsAppSessionController } from "../src/whatsapp/session/controller";
import { localDeployment } from "../src/whatsapp/session/local-deployment";
import { pairingPayload, statusLabel } from "../src/whatsapp/tui/presentation";
import { renderQr } from "../src/whatsapp/tui/qr";

const timeoutMs = Number(process.env.PAIRING_TIMEOUT_MS ?? 45_000);
const ephemeral = !process.env.WHATSAPP_DATA_DIR;
const directory = process.env.WHATSAPP_DATA_DIR ?? (await mkdtemp(join(tmpdir(), "wa-pairing-")));
const session = new WhatsAppSessionController(localDeployment({ accountId: "proof", directory }));

const seen: string[] = [];
let resolveOutcome: (value: "paired" | "online" | "terminal") => void;
const outcome = new Promise<"paired" | "online" | "terminal">((resolve) => {
  resolveOutcome = resolve;
});

const unsubscribe = session.subscribe(() => {
  const { status } = session.getSnapshot();
  const label = statusLabel(status);
  if (seen.at(-1) !== label) {
    seen.push(label);
    console.log(`· ${label}`);
  }

  const payload = pairingPayload(status);
  if (payload) {
    const code = renderQr(payload);
    console.log(`\npairing payload: ${payload.length} characters`);
    if (code) {
      console.log(`qr grid: ${code.width} columns × ${code.rows.length} rows\n`);
      for (const row of code.rows) console.log(`\u001b[97;40m${row}\u001b[0m`);
    }
    resolveOutcome("paired");
  }
  if (status?.phase === "online") resolveOutcome("online");
  if (status?.phase === "logged_out" || status?.phase === "suspended") resolveOutcome("terminal");
});

console.log(`account directory: ${directory}`);
console.log("connecting to WhatsApp…");

let result: "paired" | "online" | "terminal" | "timeout" = "timeout";
try {
  await session.attach();
  result = await Promise.race([outcome, Bun.sleep(timeoutMs).then(() => "timeout" as const)]);
} finally {
  unsubscribe();
  await session.dispose();
  if (ephemeral) await rm(directory, { recursive: true, force: true });
}

console.log(`\nstatuses observed: ${seen.join(" → ")}`);
console.log(`outcome: ${result}`);

if (result === "timeout") {
  console.error("no pairing challenge arrived; WhatsApp was never reached");
  process.exit(1);
}
if (result === "terminal") {
  console.error("the session ended before pairing could complete");
  process.exit(1);
}
console.log(
  result === "online"
    ? "already linked: stored credentials resumed a live session"
    : "WhatsApp issued a live pairing challenge — scan it to link this device",
);
