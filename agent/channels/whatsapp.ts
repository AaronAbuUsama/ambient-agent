/**
 * WhatsApp channel — the GitHub Concierge's only ingress. Wraps whatsappd's
 * Eve adapter (`whatsappd/adapters/eve`) with the group gating this agent
 * needs: only the configured group, and only messages that address the bot,
 * ever reach the model.
 *
 * Architecture (see docs/TUTORIAL.md for the full picture):
 *
 *   WhatsApp ⇄ Baileys ⇄ whatsappd sidecar (src/index.ts, a separate
 *   process) ⇄ HTTP POST /event ⇄ this channel ⇄ Eve session ⇄ GitHub tools
 *
 * Why a custom route instead of `export { default } from "whatsappd/adapters/eve"`:
 * the stock adapter starts an Eve session for every inbound message. That's
 * right for a 1:1 assistant, but wrong for a group-chat bot with GitHub
 * write access — it would burn tokens on every unrelated group message and,
 * worse, treat "everyone in the group" as implicitly authorized to trigger
 * `github_create_issue` et al. This file re-uses the adapter's exported
 * building blocks (`toUserContent`, `createEventHandlers`, `createFetchFile`)
 * for everything except the inbound route, where it adds the gate.
 *
 * Known limitation — the gate is a plain-text trigger, not a real WhatsApp
 * @-mention: the sidecar's wire format (`whatsappd/sidecar`'s `WireMessage`)
 * intentionally doesn't carry `contextInfo.mentionedJid` across the HTTP
 * bridge, so there is no mention JID to check here. "@github-bot ..." in the
 * message text is what "addressed" means in this template. See
 * docs/TUTORIAL.md for the tradeoff and how to swap in real mention
 * detection if you fork this.
 */
import { defineChannel, POST, type RouteHandlerArgs } from "eve/channels";
import {
  createEventHandlers,
  createFetchFile,
  toUserContent,
  type WhatsAppEveContext,
  type WhatsAppEveMetadata,
  type WhatsAppEveState,
} from "whatsappd/adapters/eve";
import type { SidecarEvent, WireMessage } from "whatsappd/sidecar";

/** The WhatsApp group JID this bot watches (e.g. "1203...@g.us"). */
const TARGET_GROUP = process.env.WHATSAPP_GROUP_ID?.trim() || undefined;

/** Plain-text trigger that marks a message as addressed to the bot. */
const TRIGGER = (process.env.WHATSAPP_BOT_TRIGGER?.trim() || "@github-bot").toLowerCase();

/** Opt-in: also respond to direct messages (handy for solo testing pre-group). */
const ALLOW_DM = process.env.WHATSAPP_ALLOW_DM === "true";

const SIDECAR_URL = process.env.WHATSAPP_SIDECAR_URL ?? "http://localhost:8788";
const SIDECAR_TOKEN = process.env.WHATSAPP_SIDECAR_TOKEN;

/** The plain-text body of a wire message, when it has one. */
function textOf(message: WireMessage): string {
  switch (message.kind) {
    case "text":
      return message.text;
    case "image":
    case "video":
    case "audio":
    case "document":
    case "sticker":
      return message.text ?? "";
    default:
      return "";
  }
}

/**
 * Whether a message event should reach the agent. GitHub write tools make
 * this a real access-control decision, not just noise reduction:
 *
 *  - Groups: only the configured `WHATSAPP_GROUP_ID` (when set), and only
 *    when the text contains the trigger word.
 *  - DMs: ignored by default — a WhatsApp number gets messages from anyone,
 *    and this bot can open/close issues and review PRs. Opt in with
 *    `WHATSAPP_ALLOW_DM=true` for solo testing before adding it to a group.
 */
export function isAddressed(event: Extract<SidecarEvent, { type: "message" }>): boolean {
  if (event.isGroup) {
    if (TARGET_GROUP && event.chatId !== TARGET_GROUP) return false;
  } else if (!ALLOW_DM) {
    return false;
  }
  return textOf(event.message).toLowerCase().includes(TRIGGER);
}

/**
 * `POST /event` — the sidecar's inbound webhook, gated. Same session-start
 * contract as whatsappd's own `createEventRoute` (continuationToken = chatId,
 * one WhatsApp conversation per Eve session), reimplemented here (rather than
 * wrapped) because a `Request` body can only be read once and the gate needs
 * to inspect it before deciding whether to start a session at all.
 */
export function createGatedEventRoute() {
  return async (req: Request, args: RouteHandlerArgs<WhatsAppEveState>): Promise<Response> => {
    if (SIDECAR_TOKEN && req.headers.get("authorization") !== `Bearer ${SIDECAR_TOKEN}`) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    const event = (await req.json()) as SidecarEvent;
    if (event.type !== "message" || event.message.fromMe) {
      return Response.json({ ignored: true });
    }
    if (!isAddressed(event)) {
      return Response.json({ ignored: true, reason: "not addressed" });
    }

    const { accountId, chatId, isGroup, from, pushName, message } = event;
    const session = await args.send(toUserContent(message, SIDECAR_URL), {
      auth: {
        authenticator: "whatsapp-baileys",
        principalType: "contact",
        principalId: from ?? chatId,
        attributes: {
          accountId,
          chatId,
          isGroup: String(isGroup),
          ...(from !== undefined && { from }),
          ...(pushName !== undefined && { pushName }),
        },
      },
      continuationToken: chatId,
      state: { accountId, chatId },
      title: `WhatsApp: ${pushName ?? chatId}`,
    });
    return Response.json({ sessionId: session.id });
  };
}

export default defineChannel<WhatsAppEveState, WhatsAppEveContext, Record<string, unknown>, WhatsAppEveMetadata>({
  kindHint: "whatsapp",
  context: (state) => ({ accountId: state.accountId, chatId: state.chatId }),
  metadata: (state) => ({ accountId: state.accountId, chatId: state.chatId }),
  routes: [POST("/event", createGatedEventRoute())],
  // Reply delivery, read receipts, typing, and media staging are unchanged
  // from the stock adapter — only the inbound gate is custom.
  events: createEventHandlers({}),
  fetchFile: createFetchFile({}),
});
