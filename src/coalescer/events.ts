/**
 * The Coalescer's inbound event shape.
 *
 * This mirrors — deliberately, field for field — the *full-fidelity* event
 * whatsappd emits in-process from `createChannelAdapter().subscribe()`:
 * `ChannelEvent = { type: "message"; ref: ConversationRef; message: InboundMessage }`
 * (`whatsappd/dist/types-B8d1OyHV.d.mts:22`; `InboundMessage.Base` at
 * `whatsappd/dist/update-Bi5ZPUjP.d.mts:39-101`). We flatten `{ref, message}`
 * into one record and keep the two `context` fields the *lossy HTTP sidecar*
 * drops but the in-process `subscribe()` keeps — `context.mentions` and
 * `context.quoted` (`update-Bi5ZPUjP.d.mts:14-22`). Those are the immediate-fire
 * signal, so mirroring them now is what lets the real `subscribe()` drop in
 * later with no rework.
 */

/** One inbound WhatsApp message, flattened from `{ref, message}`. */
export interface IncomingMessage {
  readonly id: string;
  /** JID: `xxx@g.us` (group) or `xxx@s.whatsapp.net` (DM). */
  readonly chatId: string;
  /** Sender JID (equals `chatId` for DMs, participant JID for groups). */
  readonly from: string;
  /** WhatsApp display name (proto `pushName`), when present. */
  readonly pushName?: string;
  /** Plain-text body; `""` for non-text kinds (mirrors the channel's `textOf`). */
  readonly text: string;
  /**
   * Epoch **milliseconds**. The real adapter multiplies `InboundMessage.timestamp`
   * (proto seconds) by 1000; we standardise on ms so buffer-age math is in one unit.
   */
  readonly timestamp: number;
  readonly isGroup: boolean;
  /** The bot's own messages — filtered out before the loop ever sees them. */
  readonly fromMe: boolean;
  /** `false` = history backfill (`messages.upsert` "append") — filtered out. */
  readonly live: boolean;
  /** `context.mentions ?? []` — the @-mention JIDs on this message. */
  readonly mentions: readonly string[];
  /** `context.quoted?.from` — the JID of the sender being quote-replied. */
  readonly quotedFrom?: string;
}

/** Why the Coalescer fired: an ambient burst settled, or the bot was addressed. */
export type FireReason = "debounce" | "mention" | "quote-reply";

/**
 * The window handed to the Conversationalist on each fire: the messages buffered
 * since the last fire, plus why we fired. This is the Coalescer's entire output.
 */
export interface ConversationWindow {
  readonly chatId: string;
  readonly messages: readonly IncomingMessage[];
  readonly reason: FireReason;
}

/**
 * Does this message directly address the bot — an @-mention or a quote-reply of
 * one of the bot's messages? This is the *only* condition that skips the
 * debounce and fires immediately. It needs the high-fidelity `mentions` /
 * `quotedFrom` fields the sidecar throws away.
 */
export const addressesBot = (msg: IncomingMessage, botId: string): boolean =>
  msg.mentions.includes(botId) || msg.quotedFrom === botId;

/** The fire reason for an addressing message (mention takes precedence over quote). */
export const reasonOf = (msg: IncomingMessage, botId: string): FireReason =>
  msg.mentions.includes(botId) ? "mention" : "quote-reply";
