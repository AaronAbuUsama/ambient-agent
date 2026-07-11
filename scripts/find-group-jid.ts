#!/usr/bin/env node
/**
 * find-group-jid — a throwaway "JID sniffer" for one-time setup.
 *
 * The whatsappd sidecar forwards every inbound event (as a `SidecarEvent`) to
 * `WHATSAPP_FORWARD_URLS`, but a message event carries only the group's JID
 * (`chatId`, e.g. "1203...@g.us") — not its display name. So the reliable way
 * to learn the JID of *the* group you want is: point the sidecar at this
 * listener, send one message *in that group*, and read the JID it prints.
 *
 * Usage (during setup, agent not required):
 *   1) In .env, temporarily set:  WHATSAPP_FORWARD_URLS=http://localhost:8790/event
 *   2) Terminal A:  npx tsx scripts/find-group-jid.ts      (this listener, :8790)
 *   3) Terminal B:  npm run whatsapp                        (pair / reconnect)
 *   4) Send a message like "jid check" IN the target group.
 *   5) Copy the printed JID into WHATSAPP_GROUP_ID, revert WHATSAPP_FORWARD_URLS
 *      back to the agent (http://localhost:2000/event), and restart.
 *
 * It ignores the Bearer token on purpose (localhost, ephemeral) and always
 * replies 200 so the sidecar's forward doesn't error.
 */
import { createServer } from "node:http";
import type { SidecarEvent } from "whatsappd/sidecar";

const PORT = Number(process.env.JID_SNIFFER_PORT ?? 8790);

function bodyText(msg: Extract<SidecarEvent, { type: "message" }>["message"]): string {
  return msg.kind === "text" ? msg.text : ("text" in msg && msg.text) || `<${msg.kind}>`;
}

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    try {
      const event = JSON.parse(raw) as SidecarEvent;
      // Print ANY message (including your own — fromMe) so the JID shows up no
      // matter who sends it in the group.
      if (event.type === "message") {
        const where = event.isGroup ? "GROUP" : "dm";
        const who = event.message.fromMe ? "you (this number)" : (event.pushName ?? event.from ?? "?");
        console.log(`\n[${where}] ${who}: ${JSON.stringify(bodyText(event.message))}`);
        console.log(`  chatId = ${event.chatId}`);
        if (event.isGroup) {
          console.log(`  → paste into .env:  WHATSAPP_GROUP_ID=${event.chatId}`);
        }
      }
    } catch {
      /* ignore non-JSON / non-message pings */
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
});

server.listen(PORT, () => {
  console.log(`find-group-jid listening on http://localhost:${PORT}/event`);
  console.log("Set WHATSAPP_FORWARD_URLS to this, run `npm run whatsapp`, then send a");
  console.log("message IN your target group. The group's WHATSAPP_GROUP_ID will print here.\n");
});
