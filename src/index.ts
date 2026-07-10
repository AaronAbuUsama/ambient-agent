#!/usr/bin/env node
/**
 * The whatsappd sidecar launcher — the other half of this bot, run as a
 * separate process from the Eve app (`npm run dev` / `npm run start`):
 *
 *   Eve app (agent/, served by `eve dev`/`eve start`)
 *     ⇅ HTTP (this process forwards inbound events, and serves /send etc.)
 *   whatsappd sidecar (this file) ⇅ Baileys WS ⇅ WhatsApp
 *
 * Run it with `npm run whatsapp`. First run prints a QR code (or a pairing
 * code, if `WHATSAPP_PAIRING_PHONE` is set) — see docs/TUTORIAL.md for the
 * pairing walkthrough. Credentials persist under `WHATSAPP_STORE_DIR`
 * (default `./.wa-auth`), so restarts reconnect silently.
 *
 * This script is a thin, friendlier wrapper around `runSidecar()` from
 * `whatsappd/sidecar` — it validates the env vars this project actually
 * needs before opening a socket, and prints setup guidance specific to the
 * GitHub Concierge agent (the group JID to watch, the trigger word). The
 * gating logic itself (which group, which trigger) lives in
 * `agent/channels/whatsapp.ts`, since that's where whatsappd's Eve adapter
 * hands events to the agent — this process only relays them.
 */
import { runSidecar } from "whatsappd/sidecar";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    console.error(`Missing required environment variable: ${name}`);
    console.error("Copy .env.example to .env and fill it in — see docs/TUTORIAL.md.");
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  requireEnv("WHATSAPP_FORWARD_URLS");

  const groupId = process.env.WHATSAPP_GROUP_ID?.trim();
  const trigger = process.env.WHATSAPP_BOT_TRIGGER?.trim() || "@github-bot";

  console.log("whatsappd-github-agent — starting the WhatsApp sidecar");
  console.log(`  forwarding to: ${process.env.WHATSAPP_FORWARD_URLS}`);
  console.log(
    groupId
      ? `  watching group: ${groupId}`
      : "  watching: ANY group (WHATSAPP_GROUP_ID unset — fine for local testing, set it before going live)",
  );
  console.log(`  trigger word:  "${trigger}"`);
  console.log("");

  const sidecar = await runSidecar();
  console.log(`whatsappd sidecar listening on :${sidecar.port}`);
  console.log("Scan the QR above in WhatsApp -> Linked devices (first run only).");

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} received, shutting down sidecar...`);
    await sidecar.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error("whatsappd sidecar failed to start:", err);
  process.exit(1);
});
