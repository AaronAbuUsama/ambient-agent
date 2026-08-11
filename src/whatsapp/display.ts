import type {
  ChatRecord,
  ClientChatMessages,
  ContactRecord,
  MessageRecord,
  ReceiptStatus,
  Status,
} from "whatsappd";

/**
 * Strip the WhatsApp domain from a native address and mark a bare phone number.
 *
 * @remarks
 * Only `s.whatsapp.net` carries a phone number. A `@lid` — WhatsApp's opaque
 * linked identifier — and a `@g.us` group id are both fifteen-ish digits,
 * exactly the shape of an E.164 address, and neither is a number anyone can
 * dial. A contact alias is what turns a lid into a name, and most do; until one
 * arrives the honest label is the identifier, not a number that would ring the
 * wrong person.
 */
export function addressLabel(nativeId: string): string {
  const [local = nativeId, domain] = nativeId.split("@");
  const number = local.split(":")[0] ?? local;
  const dialable = domain === undefined || domain === "s.whatsapp.net";
  return dialable && /^\d{6,}$/.test(number) ? `+${number}` : number;
}

/**
 * The name to show for a chat.
 *
 * @param chat - The mirror's chat summary.
 * @param resolve - Address resolution, normally `client.contacts.resolve`.
 *
 * @remarks
 * A group carries its own subject; a 1:1 chat carries none, and its title lives
 * on the contact record that owns the address. Falling through to the address
 * matters more than it looks — a chat can exist in the mirror before any
 * contact update for it has arrived, and an empty row is worse than a number.
 */
export function chatTitle(
  chat: ChatRecord,
  resolve: (nativeId: string) => ContactRecord | undefined,
): string {
  if (chat.isGroup) return chat.subject?.trim() || addressLabel(chat.chatId);
  const contact = resolve(chat.chatId);
  const named =
    contact?.displayName ?? contact?.profileName ?? contact?.verifiedName ?? contact?.username;
  return named?.trim() || chat.subject?.trim() || addressLabel(chat.chatId);
}

/** `HH:MM` in local time, or an empty string when the instant is unknown. */
export function clockTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * The one-line body to show for a message of any kind.
 *
 * @remarks
 * Every `MessageRecord` variant gets a line, including the ones with no text at
 * all: a media message with no caption, a revoked message, and a kind this build
 * does not know about are all things a transcript has to draw rather than skip.
 */
export function messageBody(message: MessageRecord): string {
  switch (message.kind) {
    case "text":
      return message.text;
    case "image":
    case "video":
    case "audio":
    case "document":
    case "sticker": {
      const caption = message.text?.trim();
      const label = `[${message.kind}]`;
      return caption ? `${label} ${caption}` : label;
    }
    case "location":
      return `[location] ${message.name ?? `${message.lat}, ${message.lng}`}`;
    case "contacts":
      return `[contacts] ${message.contacts.map((entry) => entry.name ?? "card").join(", ")}`;
    case "poll":
      return `[poll] ${message.name}`;
    case "revoked":
      return "[deleted]";
    case "unsupported":
      return `[${message.rawType}]`;
  }
}

/** WhatsApp's delivery ladder, ordered so the furthest rung wins. */
const receiptRank: Record<ReceiptStatus, number> = {
  pending: 0,
  server_ack: 1,
  delivered: 2,
  read: 3,
  played: 4,
  error: 5,
};

/**
 * How far a message we sent has travelled, or `null` for one we received.
 *
 * @remarks
 * WhatsApp's ladder is monotonic in practice but arrives out of order in
 * groups, where every participant contributes a receipt. Ranking and taking the
 * furthest is what stops one straggler's `delivered` from un-reading a message
 * every other participant has already read. `error` outranks everything: a send
 * rejected after the fact is the one outcome a sender has to act on.
 */
export function furthestReceipt(message: MessageRecord): ReceiptStatus | null {
  if (!message.fromMe) return null;
  let furthest: ReceiptStatus = "pending";
  for (const receipt of message.receipts) {
    if (receiptRank[receipt.status] > receiptRank[furthest]) furthest = receipt.status;
  }
  return furthest;
}

/** A short, human phrase for the connection lifecycle. */
export function statusLabel(status: Status | null): string {
  if (!status) return "offline";
  switch (status.phase) {
    case "disconnected":
      return "disconnected";
    case "connecting":
      return status.retryAttempt ? `connecting (retry ${status.retryAttempt})` : "connecting";
    case "pairing":
      switch (status.pairing.step) {
        case "awaiting_ready":
          return "preparing pairing code";
        case "challenge_live":
          return "scan to link";
        case "restart_pending":
          return "linked — restarting";
      }
    // falls through to the exhaustive default below when a step is unknown
    case "authenticated":
      return status.sync.step === "draining" ? "syncing" : "syncing history";
    case "online":
      return "online";
    case "backing_off":
      return `reconnecting in ${Math.max(0, Math.ceil((status.nextRetryAt - Date.now()) / 1000))}s`;
    case "logged_out":
      return `logged out (${status.reason})`;
    case "suspended":
      return `suspended (${status.reason})`;
  }
}

/** The live pairing QR payload, present only while a challenge is on screen. */
export function pairingPayload(status: Status | null): string | null {
  if (status?.phase !== "pairing") return null;
  if (status.pairing.step !== "challenge_live") return null;
  return status.pairing.qr ?? null;
}

/**
 * What the transcript header says about how much of this chat is here.
 *
 * @remarks
 * The Client's own words are `stored`, `loading`, and `exhausted`, and none of
 * the three mean to a human what they mean to the mirror. `exhausted`
 * especially: it says nothing older is *saved here*, and says nothing at all
 * about what the phone still holds (ADR-0010). A header that printed the enum
 * would be claiming the second, so the header stays quiet on it and the banner
 * at the top of the transcript — where a human has actually scrolled to the
 * end of what exists — is the only place that says it.
 */
export function transcriptStatus(chat: ClientChatMessages | null): string {
  if (!chat) return "not connected";
  const held = `${chat.messages.length} message${chat.messages.length === 1 ? "" : "s"}`;
  switch (chat.older) {
    case "loading":
      return `${held} · loading earlier`;
    case "stored":
      return `${held} · o for earlier`;
    case "exhausted":
      return chat.messages.length === 0 ? "nothing saved for this chat" : held;
  }
}

const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * When a chat last moved, in at most five columns.
 *
 * @param now - Read once per render rather than per row, so every row in one
 * frame agrees on where "today" ends.
 *
 * @remarks
 * The sidebar is ordered by exactly this instant and there is no other way to
 * see it: a list of names in an order you cannot check is a list you assume is
 * wrong. Resolution falls off the way attention does — a time for today, a
 * weekday for the last week, a date beyond that.
 */
export function lastActivityStamp(timestamp: number, now: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  const at = new Date(timestamp);
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  if (timestamp >= midnight.getTime()) return clockTime(timestamp);
  if (timestamp >= midnight.getTime() - 6 * 86_400_000) return weekdays[at.getDay()]!;
  return `${String(at.getDate()).padStart(2, "0")}/${String(at.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * One sidebar row: the name on the left, when it last moved on the right.
 *
 * @param width - Columns the row's text actually gets, which is two fewer than
 * the sidebar: the row is inset by one and the sidebar reserves one.
 *
 * @remarks
 * The stamp is the first thing dropped when the pane is narrow. A truncated
 * name is still a name a human recognises; a name truncated to make room for a
 * date is two things you cannot read instead of one you can.
 */
export function chatRowLabel(name: string, stamp: string, width: number): string {
  if (width <= 0) return "";
  const room = width - stamp.length - 1;
  if (!stamp || room < 4) {
    return name.length > width ? `${name.slice(0, width - 1)}…` : name;
  }
  const fitted = name.length > room ? `${name.slice(0, room - 1)}…` : name.padEnd(room);
  return `${fitted} ${stamp}`;
}
