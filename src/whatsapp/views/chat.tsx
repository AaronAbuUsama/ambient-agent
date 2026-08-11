import {
  MessageComposer,
  useTheme,
  type ScrollBoxRenderable,
  type TextareaRenderable,
} from "agentic-tui-kit";
import type { RefObject } from "react";
import type { ClientChatMessages, ContactRecord, MessageRecord } from "whatsappd";
import {
  addressLabel,
  clockTime,
  furthestReceipt,
  messageBody,
  transcriptStatus,
} from "../display";

/**
 * How wide a message is allowed to get before it wraps.
 *
 * @remarks
 * Anything approaching the full width defeats the alignment: two columns of
 * text that both reach both edges read as one column whoever sent them.
 */
const bubbleWidth = "72%";

/** The glyph and tone for how far a sent message has travelled. */
function receiptGlyph(
  message: MessageRecord,
  theme: { textMuted: string; textDim: string; positive: string; negative: string },
): { glyph: string; tone: string } {
  switch (furthestReceipt(message)) {
    case null:
      return { glyph: "", tone: theme.textMuted };
    case "error":
      return { glyph: "!", tone: theme.negative };
    case "played":
    case "read":
      return { glyph: "✓✓", tone: theme.positive };
    case "delivered":
      return { glyph: "✓✓", tone: theme.textDim };
    case "server_ack":
      return { glyph: "✓", tone: theme.textDim };
    default:
      return { glyph: "·", tone: theme.textMuted };
  }
}

/**
 * One message, anchored to the side that sent it.
 *
 * @remarks
 * Side carries authorship, so the sender's name only has to appear on the
 * incoming side; "you" would be saying twice what the right margin already
 * said. A group still needs the participant's name, and gets it, because there
 * the left side is several different people.
 *
 * Nothing here takes a pixel width. The scrollbox reserves a column for its
 * scrollbar out of the same width the pane hands the transcript, so a row sized
 * to the pane loses its last column the moment the bar appears — which is
 * exactly when there is enough history to want it.
 */
function Row({
  message,
  previous,
  senderName,
}: {
  message: MessageRecord;
  previous: MessageRecord | undefined;
  senderName: string;
}) {
  const { theme } = useTheme();
  const mine = message.fromMe;
  const grouped = previous?.sender.id === message.sender.id && previous.fromMe === mine;
  const receipt = receiptGlyph(message, theme);
  const revoked = message.kind === "revoked";
  const time = clockTime(message.timestamp);

  return (
    <box
      width="100%"
      flexDirection="column"
      alignItems={mine ? "flex-end" : "flex-start"}
      data-app-role="chat-message"
    >
      <box
        maxWidth={bubbleWidth}
        flexDirection="column"
        alignItems={mine ? "flex-end" : "flex-start"}
      >
        {grouped ? null : (
          <box height={1} flexDirection="row">
            {mine ? null : (
              <text fg={theme.textBright}>
                <strong>{senderName}</strong>
              </text>
            )}
            <text fg={theme.textMuted}>{mine ? time : ` ${time}`}</text>
          </box>
        )}
        <box flexDirection="row" alignItems="flex-end">
          <box flexShrink={1}>
            <text fg={revoked ? theme.textMuted : theme.text} wrapMode="word">
              {messageBody(message)}
            </text>
          </box>
          {receipt.glyph ? <text fg={receipt.tone}>{` ${receipt.glyph}`}</text> : null}
        </box>
      </box>
    </box>
  );
}

/**
 * One chat's transcript and composer.
 *
 * @remarks
 * The transcript draws the Client's retained messages *and* its optimistic
 * outgoing sends, because a durable send stays optimistic until its
 * authoritative message arrives — dropping those would make a just-sent message
 * vanish for as long as the round trip takes.
 *
 * An empty transcript is drawn as "re-pageable" rather than "nothing here": the
 * Client empties a chat and re-reads it whenever it misses a revision, so an
 * empty view is a signal to page, never proof the chat has no messages.
 */
export function ChatView({
  title,
  chat,
  width,
  height,
  composerFocused,
  draft,
  scrollRef,
  inputRef,
  resolve,
  onFocusComposer,
  onDraft,
  onSubmit,
}: {
  title: string;
  chat: ClientChatMessages | null;
  width: number;
  height: number;
  composerFocused: boolean;
  draft: string;
  scrollRef: RefObject<ScrollBoxRenderable | null>;
  inputRef: RefObject<TextareaRenderable | null>;
  resolve: (nativeId: string) => ContactRecord | undefined;
  onFocusComposer: () => void;
  onDraft: (value: string) => void;
  onSubmit: () => void;
}) {
  const { theme } = useTheme();
  const messages = chat?.messages ?? [];
  const outgoing = chat?.outgoing ?? [];
  // The Client holds messages newest first; a transcript reads oldest first.
  const ordered = [...messages].reverse();
  const transcriptHeight = Math.max(1, height - 4);

  return (
    <box width={width} height={height} flexDirection="column">
      <box height={1} flexDirection="row">
        <text fg={theme.textBright}>
          <strong>{title}</strong>
        </text>
        <box flexGrow={1} />
        <text fg={theme.textMuted}>{transcriptStatus(chat)}</text>
      </box>
      <box height={1}>
        <text fg={theme.border}>{"─".repeat(Math.max(1, width))}</text>
      </box>

      <scrollbox
        ref={scrollRef}
        width={width}
        height={transcriptHeight}
        scrollY
        stickyScroll
        stickyStart="bottom"
        aria-label={`${title} transcript`}
      >
        {chat && ordered.length > 0 ? (
          <box width="100%" height={1} alignItems="center">
            <text fg={theme.textMuted}>
              {chat.older === "loading"
                ? "loading earlier messages…"
                : chat.older === "stored"
                  ? "[o] load earlier messages"
                  : "— start of saved history —"}
            </text>
          </box>
        ) : null}
        {ordered.length === 0 ? (
          <box width="100%" height={1}>
            <text fg={theme.textMuted}>
              {chat ? "No messages held here yet — press o to page." : "Connect to read this chat."}
            </text>
          </box>
        ) : null}
        {ordered.map((message, index) => (
          <Row
            key={message.messageId}
            message={message}
            previous={ordered[index - 1]}
            senderName={resolve(message.sender.id)?.displayName ?? addressLabel(message.sender.id)}
          />
        ))}
        {outgoing.map((pending) => (
          <box key={pending.operationId} width="100%" flexDirection="row" justifyContent="flex-end">
            <box maxWidth={bubbleWidth} flexShrink={1}>
              <text fg={theme.textDim} wrapMode="word">
                {"text" in pending.content ? pending.content.text : "[attachment]"}
              </text>
            </box>
            <text fg={pending.state.status === "failed" ? theme.negative : theme.textMuted}>
              {pending.state.status === "failed" ? " !" : " …"}
            </text>
          </box>
        ))}
      </scrollbox>

      <MessageComposer
        inputRef={inputRef}
        initialValue={draft}
        focused={composerFocused}
        identity="you"
        placeholder="Type a message…"
        width={width}
        onFocusRequest={onFocusComposer}
        onInput={onDraft}
        onSubmit={onSubmit}
      />
    </box>
  );
}
