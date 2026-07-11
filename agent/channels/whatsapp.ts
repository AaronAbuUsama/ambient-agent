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
import { timingSafeEqual } from "node:crypto";
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

/** Comma-separated env value → a Set of trimmed, lower-cased entries. */
function envSet(raw: string | undefined): ReadonlySet<string> {
  const set = new Set<string>();
  for (const part of (raw ?? "").split(",")) {
    const v = part.trim().toLowerCase();
    if (v) set.add(v);
  }
  return set;
}

/**
 * Group JIDs this bot watches. Accepts `WHATSAPP_GROUP_IDS` (comma list) or the
 * singular `WHATSAPP_GROUP_ID`. When EMPTY the bot ignores every group (fail
 * closed) unless `WHATSAPP_ALLOW_ANY_GROUP=true` is set explicitly — a misconfig
 * should silence the bot, never open it to every group the number is in.
 */
const GROUP_ALLOWLIST = envSet(process.env.WHATSAPP_GROUP_IDS ?? process.env.WHATSAPP_GROUP_ID);
const ALLOW_ANY_GROUP = process.env.WHATSAPP_ALLOW_ANY_GROUP === "true";

/**
 * Optional per-sender allow-list (phone numbers or JIDs, comma-separated). When
 * set, only these senders can trigger the bot — a second gate beyond group
 * membership, because any member's message can drive GitHub *writes*.
 */
const SENDER_ALLOWLIST = envSet(process.env.WHATSAPP_ALLOWED_SENDERS);

/** Plain-text trigger that marks a message as addressed to the bot. */
const TRIGGER = (process.env.WHATSAPP_BOT_TRIGGER?.trim() || "@github-bot").toLowerCase();

/** Opt-in: also respond to direct messages (handy for solo testing pre-group). */
const ALLOW_DM = process.env.WHATSAPP_ALLOW_DM === "true";

const SIDECAR_URL = process.env.WHATSAPP_SIDECAR_URL ?? "http://localhost:8788";
const SIDECAR_TOKEN = process.env.WHATSAPP_SIDECAR_TOKEN;

if (!SIDECAR_TOKEN) {
  console.warn(
    "[whatsapp] WHATSAPP_SIDECAR_TOKEN is not set — the /event webhook is UNAUTHENTICATED. " +
      "Set it (and point the sidecar at it) before exposing this beyond localhost.",
  );
}
if (GROUP_ALLOWLIST.size === 0 && !ALLOW_ANY_GROUP) {
  console.warn(
    "[whatsapp] No WHATSAPP_GROUP_ID(S) configured — all group messages are ignored. " +
      "Set the target group JID, or WHATSAPP_ALLOW_ANY_GROUP=true to accept any group (not recommended).",
  );
}

/** Digits-only identity of a JID/number, for order-insensitive sender matching. */
function senderDigits(jid: string | undefined): string {
  return (jid ?? "").split("@")[0]!.replace(/\D/g, "");
}

/** Constant-time string equality, to keep the sidecar-token check off the timing side-channel. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

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
    if (GROUP_ALLOWLIST.size > 0) {
      if (!GROUP_ALLOWLIST.has(event.chatId.toLowerCase())) return false;
    } else if (!ALLOW_ANY_GROUP) {
      return false; // fail closed: no group configured
    }
  } else if (!ALLOW_DM) {
    return false;
  }
  if (SENDER_ALLOWLIST.size > 0) {
    const digits = senderDigits(event.from);
    if (digits === "" || ![...SENDER_ALLOWLIST].some((e) => senderDigits(e) === digits)) return false;
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
    if (SIDECAR_TOKEN && !safeEqual(req.headers.get("authorization") ?? "", `Bearer ${SIDECAR_TOKEN}`)) {
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
