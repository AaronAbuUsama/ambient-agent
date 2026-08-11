import {
  addressFields,
  definePanel,
  getPaneSidebarWidth,
  humanKeyboardContext,
  humanPointerContext,
  PaneSidebar,
  PaneSidebarRow,
  shouldShowPaneSidebar,
  systemContext,
  useAppStatus,
  useKeyHints,
  useShortcut,
  useTheme,
  type ActionInvocationContext,
  type PanelDefinition,
  type ScrollBoxRenderable,
  type TextareaRenderable,
} from "agentic-tui-kit";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  addressLabel,
  chatRowLabel,
  chatTitle,
  lastActivityStamp,
  pairingPayload,
  statusLabel,
} from "./display";
import type { WhatsAppEngine } from "./engine";
import { whatsAppActions } from "./ids";
import { whatsAppTargetSchema, type WhatsAppTarget } from "./target";
import { ChatView } from "./views/chat";
import { PairingView } from "./views/pairing";
import { SettingsView } from "./views/settings";

/** The sidebar's settings entry, kept out of the chat index it sits beside. */
const settingsRow = "__settings__";

/** Which slice of the chat list the sidebar is showing. */
const chatFilters = ["all", "direct", "groups"] as const;
type ChatFilter = (typeof chatFilters)[number];

/**
 * How much history to page in before leaving the rest to the human.
 *
 * @remarks
 * A page the human never sees is wasted work, and the Client pages from local
 * storage — cheap, but not free. Enough to fill the transcript and scroll back
 * a screen is what makes the chat feel already-loaded; past that, `o` is a
 * better answer than a loop that reads a year of history nobody asked for.
 */
const backfillPages = 4;

export function defineWhatsAppPanel(engine: WhatsAppEngine): PanelDefinition<WhatsAppTarget> {
  return definePanel({
    type: "whatsapp",
    schema: whatsAppTargetSchema,
    address: addressFields("view", "chatId"),
    title: (target) => {
      if (target.view === "settings") return "WhatsApp · Settings";
      const chat = engine
        .getSnapshot()
        .chats.find((candidate) => candidate.chatId === target.chatId);
      const named = chat
        ? chatTitle(chat, (nativeId) => engine.resolveContact(nativeId))
        : addressLabel(target.chatId);
      return `WhatsApp · ${named}`;
    },
    render: ({ panel, actions }) => {
      const { theme } = useTheme();
      const snapshot = useSyncExternalStore(
        engine.subscribe,
        engine.getSnapshot,
        engine.getSnapshot,
      );
      const { view, chatId } = panel.target;

      const width = Math.max(1, panel.rect.width - 2);
      const height = Math.max(1, panel.rect.height - 3);

      const pairing = pairingPayload(snapshot.status);

      // Read once, not per row: every stamp in one frame has to agree on where
      // today ends, or a list rendered across midnight disagrees with itself.
      const now = Date.now();
      const allChats = [...snapshot.chats].sort(
        (left, right) => right.lastMessageAt - left.lastMessageAt,
      );
      // A live pairing code needs roughly twice as many columns as rows and
      // gets no second chance: a clipped QR does not scan. While one is on
      // screen the chat list stands down and the pane is the code's.
      // Sized on the whole list, not the filtered one: a filter that empties the
      // list must not also take away the control that would undo it.
      const showSidebar = !pairing && shouldShowPaneSidebar(allChats.length + 1, width, height);
      const sidebarWidth = showSidebar ? getPaneSidebarWidth(width) : 0;
      const contentWidth = Math.max(1, width - sidebarWidth - 2);

      const [sidebarFocused, setSidebarFocused] = useState(false);
      const [sidebarSelection, setSidebarSelection] = useState(0);
      const [composerFocused, setComposerFocused] = useState(false);
      const [drafts, setDrafts] = useState<Record<string, string>>({});
      const [error, setError] = useState<string | null>(null);
      const [filter, setFilter] = useState<ChatFilter>("all");
      const inputRef = useRef<TextareaRenderable | null>(null);
      const scrollRef = useRef<ScrollBoxRenderable | null>(null);
      /** Auto-pages already requested per chat, so a stalled page cannot loop. */
      const backfilled = useRef(new Map<string, number>());

      const chats = allChats.filter(
        (chat) => filter === "all" || (filter === "groups") === chat.isGroup,
      );
      // The hint bar already separates its entries with `·`; a label carrying
      // one of its own reads as two hints.
      const filterHint = `filter: ${filter}`;
      const filterLabel = `${filter} · ${chats.length}`;
      const rows = [...chats.map((chat) => chat.chatId), settingsRow];
      const draft = drafts[chatId] ?? "";
      const chatMessages = view === "chat" ? engine.chatMessages(chatId) : null;

      const cycleFilter = () => {
        setSidebarSelection(0);
        setFilter(
          (current) => chatFilters[(chatFilters.indexOf(current) + 1) % chatFilters.length]!,
        );
      };

      const run = async (
        actionId: string,
        input: unknown = {},
        context: ActionInvocationContext = humanKeyboardContext,
      ) => {
        const result = await actions.invokeId(actionId, input, context);
        setError(result.ok ? null : result.error.message);
        return result;
      };

      const openRow = (row: string, pointer = false) => {
        const context = pointer ? humanPointerContext : humanKeyboardContext;
        return row === settingsRow
          ? run(whatsAppActions.openSettings, {}, context)
          : run(whatsAppActions.openChat, { chatId: row }, context);
      };

      const focusComposer = () => {
        setSidebarFocused(false);
        setComposerFocused(true);
        inputRef.current?.focus();
      };

      const submit = async () => {
        const text = draft.trim();
        if (!text || view !== "chat") return;
        const result = await run(whatsAppActions.send, { chatId, text });
        if (!result.ok) return;
        setDrafts((current) => ({ ...current, [chatId]: "" }));
        inputRef.current?.setText("");
      };

      useEffect(() => {
        setComposerFocused(false);
        setSidebarFocused(false);
        setError(null);
      }, [view, chatId]);

      // The Client retains a chat only once something reads or sends to it, so
      // a chat opened for the first time holds nothing until it is paged, and it
      // empties and re-reads whenever it misses a revision. Rather than leave a
      // human pressing `o` at an empty screen, page until there is a transcript
      // to scroll, then stop and let them ask for the rest.
      //
      // The budget cannot stall the loop: the mirror only reports `stored` when
      // an older row actually exists, so every page it grants comes back with
      // messages and `held` climbs until `exhausted`. It resets on an empty
      // transcript because that is a re-read starting over, not the same chat
      // asking for a fifth page.
      const pageable = chatMessages?.older === "stored";
      const held = chatMessages?.messages.length ?? 0;
      useEffect(() => {
        if (view !== "chat" || !pageable) return;
        const requested = held === 0 ? 0 : (backfilled.current.get(chatId) ?? 0);
        if (requested >= backfillPages) return;
        backfilled.current.set(chatId, requested + 1);
        void actions.invokeId(whatsAppActions.loadOlder, { chatId }, systemContext);
      }, [view, chatId, pageable, held]);

      // The header says only what a human can act on. A warm start finishes the
      // walk in about six frames, so announcing progress there would be a
      // flicker of numbers nobody can read; `capped` is the state that lasts and
      // the one that means "there is more, and `o` is how you get it".
      useAppStatus(
        snapshot.backfill.state === "capped"
          ? [
              {
                label: `${snapshot.backfill.messages} messages held · o for older`,
                tone: "warning",
              },
            ]
          : [],
        { enabled: panel.focused },
      );

      useKeyHints(
        composerFocused
          ? [
              { key: "Enter", label: "send" },
              { key: "Esc", label: "cancel" },
            ]
          : sidebarFocused
            ? [
                { key: "↑↓", label: "chat" },
                { key: "Enter", label: "open" },
                ...(showSidebar ? [{ key: "f", label: filterHint }] : []),
                { key: "Esc", label: "back" },
              ]
            : view === "settings"
              ? [
                  { key: "c/d/x", label: "connect · disconnect · reconnect" },
                  { key: "u", label: "unlink" },
                  ...(showSidebar
                    ? [
                        { key: "f", label: filterHint },
                        { key: "←", label: "chats" },
                      ]
                    : []),
                ]
              : [
                  { key: "i", label: "message" },
                  { key: "o", label: "older" },
                  { key: "m", label: "mark read" },
                  { key: "^,", label: "settings" },
                  ...(showSidebar
                    ? [
                        { key: "f", label: filterHint },
                        { key: "←", label: "chats" },
                      ]
                    : []),
                ],
        { enabled: panel.focused, priority: 10 },
      );

      useShortcut(
        (event) => {
          if (!panel.focused) return;

          if (event.name === "escape") {
            if (composerFocused) {
              event.preventDefault();
              event.stopPropagation();
              inputRef.current?.blur();
              setComposerFocused(false);
              return;
            }
            if (sidebarFocused) {
              event.preventDefault();
              setSidebarFocused(false);
              return;
            }
            if (error) {
              event.preventDefault();
              setError(null);
            }
            return;
          }
          if (composerFocused) return;

          // Above the sidebar branch, which swallows everything it does not
          // navigate with: the filter belongs to the list, so it has to work
          // from inside it as well as from the pane beside it.
          if (event.name === "f" && showSidebar) {
            event.preventDefault();
            cycleFilter();
            return;
          }

          if (sidebarFocused) {
            if (["up", "down", "j", "k"].includes(event.name)) {
              event.preventDefault();
              const delta = event.name === "up" || event.name === "k" ? -1 : 1;
              setSidebarSelection((current) => (current + delta + rows.length) % rows.length);
              return;
            }
            if (event.name === "return") {
              event.preventDefault();
              const row = rows[sidebarSelection];
              if (row) void openRow(row);
              return;
            }
            if (event.name === "right") {
              event.preventDefault();
              setSidebarFocused(false);
            }
            return;
          }

          if (event.name === "left" && showSidebar) {
            event.preventDefault();
            setSidebarFocused(true);
            setSidebarSelection(
              view === "settings" ? rows.length - 1 : Math.max(0, rows.indexOf(chatId)),
            );
            return;
          }

          if (view === "settings") {
            const control: Record<string, string> = {
              c: whatsAppActions.connect,
              d: whatsAppActions.disconnect,
              x: whatsAppActions.reconnect,
              u: whatsAppActions.unlink,
            };
            const actionId = control[event.name];
            if (actionId) {
              event.preventDefault();
              void run(actionId);
            }
            return;
          }

          if (event.name === "i" || event.name === "return") {
            event.preventDefault();
            focusComposer();
            return;
          }
          if (event.name === "o") {
            event.preventDefault();
            void run(whatsAppActions.loadOlder, { chatId });
            return;
          }
          if (event.name === "m") {
            event.preventDefault();
            void run(whatsAppActions.markRead, { chatId });
          }
        },
        { enabled: panel.focused, scope: `whatsapp:${panel.id}`, allowEditable: true },
      );

      // Unfiltered: the open chat keeps its name while the sidebar is showing a
      // slice that excludes it, and a chat the mirror has not caught up with
      // still gets a readable address rather than a raw JID.
      const activeChat = allChats.find((candidate) => candidate.chatId === chatId);
      const heading =
        view === "settings"
          ? "Settings"
          : activeChat
            ? chatTitle(activeChat, (nativeId) => engine.resolveContact(nativeId))
            : addressLabel(chatId);

      if (pairing) {
        return (
          <box width={width} height={height} flexDirection="column" backgroundColor={theme.panel}>
            <PairingView
              payload={pairing}
              status={statusLabel(snapshot.status)}
              width={width}
              height={height}
            />
          </box>
        );
      }

      return (
        <box width={width} height={height} flexDirection="row" backgroundColor={theme.panel}>
          {showSidebar ? (
            <PaneSidebar
              width={sidebarWidth}
              height={height}
              focused={panel.focused}
              keyboardFocused={sidebarFocused}
              label="WhatsApp chats"
            >
              <box
                height={3}
                width={Math.max(1, sidebarWidth - 1)}
                paddingLeft={1}
                flexDirection="column"
              >
                <text fg={theme.textBright}>
                  <strong>CHATS</strong>
                </text>
                <text fg={snapshot.status?.phase === "online" ? theme.positive : theme.warning}>
                  {statusLabel(snapshot.status)}
                </text>
                <box
                  height={1}
                  flexDirection="row"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    cycleFilter();
                  }}
                  aria-label={`Filter chats: ${filter}`}
                  data-app-role="chat-filter"
                >
                  <text fg={theme.warning}>[f] </text>
                  <text fg={filter === "all" ? theme.textDim : theme.textBright}>
                    {filterLabel}
                  </text>
                </box>
              </box>
              {chats.length === 0 ? (
                <box height={1} paddingLeft={1}>
                  <text fg={theme.textMuted}>{`no ${filter} chats`}</text>
                </box>
              ) : null}
              {chats.map((chat, index) => (
                <PaneSidebarRow
                  key={chat.chatId}
                  active={
                    sidebarFocused
                      ? sidebarSelection === index
                      : view === "chat" && chat.chatId === chatId
                  }
                  label={chatRowLabel(
                    `${chat.isGroup ? "#" : "@"} ${chatTitle(chat, (nativeId) => engine.resolveContact(nativeId))}`,
                    lastActivityStamp(chat.lastMessageAt, now),
                    // Row text is `sidebarWidth - 2`; one more keeps the stamp
                    // off the divider it would otherwise touch.
                    Math.max(1, sidebarWidth - 3),
                  )}
                  role="chat"
                  onSelect={() => void openRow(chat.chatId, true)}
                />
              ))}
              <box flexGrow={1} />
              <PaneSidebarRow
                active={sidebarFocused ? sidebarSelection === rows.length - 1 : view === "settings"}
                label="⚙ Settings"
                role="settings"
                onSelect={() => void openRow(settingsRow, true)}
              />
            </PaneSidebar>
          ) : null}

          <box
            width={Math.max(1, width - sidebarWidth)}
            height={height}
            flexDirection="column"
            paddingX={1}
          >
            {error ? (
              <box height={1} flexDirection="row">
                <text fg={theme.negative}>{`Error: ${error}`}</text>
                <box flexGrow={1} />
                <text fg={theme.textDim}>Esc clears</text>
              </box>
            ) : null}
            {view === "settings" ? (
              <SettingsView
                snapshot={snapshot}
                width={contentWidth}
                height={Math.max(1, height - (error ? 1 : 0))}
                onRun={(actionId) => void run(actionId, {}, humanPointerContext)}
              />
            ) : (
              <ChatView
                title={heading}
                chat={chatMessages}
                width={contentWidth}
                height={Math.max(1, height - (error ? 1 : 0))}
                composerFocused={panel.focused && composerFocused}
                draft={draft}
                scrollRef={scrollRef}
                inputRef={inputRef}
                resolve={(nativeId) => engine.resolveContact(nativeId)}
                onFocusComposer={focusComposer}
                onDraft={(value) => setDrafts((current) => ({ ...current, [chatId]: value }))}
                onSubmit={() => void submit()}
              />
            )}
          </box>
        </box>
      );
    },
  });
}
