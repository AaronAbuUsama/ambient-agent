import {
  addressFields,
  definePanel,
  getPaneSidebarWidth,
  humanPointerContext,
  shouldShowPaneSidebar,
  useAppStatus,
  useKeyHints,
  useShortcut,
  useTheme,
  type PanelDefinition,
} from "agentic-tui-kit";
import { useSyncExternalStore } from "react";
import { addressLabel, chatTitle, pairingPayload, statusLabel } from "./presentation";
import type { WhatsAppSessionController } from "../session/controller";
import { whatsAppActions } from "../actions/ids";
import { ChatSidebar } from "./chat-sidebar";
import { whatsAppTargetSchema, type WhatsAppTarget } from "./route";
import { settingsRow, useWhatsAppPanelController } from "./use-panel-controller";
import { ChatView } from "./views/chat";
import { PairingView } from "./views/pairing";
import { SettingsView } from "./views/settings";

export function defineWhatsAppPanel(
  session: WhatsAppSessionController,
): PanelDefinition<WhatsAppTarget> {
  return definePanel({
    type: "whatsapp",
    schema: whatsAppTargetSchema,
    address: addressFields("view", "chatId"),
    title: (target) => {
      if (target.view === "settings") return "WhatsApp · Settings";
      const chat = session
        .getSnapshot()
        .chats.find((candidate) => candidate.chatId === target.chatId);
      const named = chat
        ? chatTitle(chat, (nativeId) => session.resolveContact(nativeId))
        : addressLabel(target.chatId);
      return `WhatsApp · ${named}`;
    },
    render: ({ panel, actions }) => {
      const { theme } = useTheme();
      const snapshot = useSyncExternalStore(
        session.subscribe,
        session.getSnapshot,
        session.getSnapshot,
      );
      const { view, chatId } = panel.target;

      const width = Math.max(1, panel.rect.width - 2);
      const height = Math.max(1, panel.rect.height - 3);

      const pairing = pairingPayload(snapshot.status);

      // Read once, not per row: every stamp in one frame has to agree on where
      // today ends, or a list rendered across midnight disagrees with itself.
      const now = Date.now();
      const controller = useWhatsAppPanelController({
        session,
        actions,
        target: panel.target,
      });
      const {
        allChats,
        chats,
        rows,
        draft,
        chatMessages,
        filter,
        error,
        sidebarFocused,
        sidebarSelection,
        composerFocused,
        inputRef,
        scrollRef,
        cycleFilter,
        run,
        openRow,
        focusComposer,
        submit,
        setError,
        setSidebarFocused,
        setSidebarSelection,
        setComposerFocused,
        setDrafts,
      } = controller;

      // A live pairing code needs roughly twice as many columns as rows and
      // gets no second chance: a clipped QR does not scan. While one is on
      // screen the chat list stands down and the pane is the code's.
      // Sized on the whole list, not the filtered one: a filter that empties the
      // list must not also take away the control that would undo it.
      const showSidebar = !pairing && shouldShowPaneSidebar(allChats.length + 1, width, height);
      const sidebarWidth = showSidebar ? getPaneSidebarWidth(width) : 0;
      const contentWidth = Math.max(1, width - sidebarWidth - 2);
      // The hint bar already separates its entries with `·`; a label carrying
      // one of its own reads as two hints.
      const filterHint = `filter: ${filter}`;

      // The header says only what a human can act on. A warm start finishes the
      // walk in about six frames, so announcing progress there would be a
      // flicker of numbers nobody can read; `capped` is the state that lasts and
      // the one that means "there is more, and `o` is how you get it".
      useAppStatus(
        snapshot.historyPrefetch.state === "capped"
          ? [
              {
                label: `${snapshot.historyPrefetch.messages} messages held · o for older`,
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
            ? chatTitle(activeChat, (nativeId) => session.resolveContact(nativeId))
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
            <ChatSidebar
              width={sidebarWidth}
              height={height}
              panelFocused={panel.focused}
              keyboardFocused={sidebarFocused}
              selection={sidebarSelection}
              filter={filter}
              chats={chats}
              activeChatId={view === "chat" ? chatId : null}
              settingsActive={view === "settings"}
              status={snapshot.status}
              now={now}
              resolve={(nativeId) => session.resolveContact(nativeId)}
              onCycleFilter={cycleFilter}
              onOpenChat={(selected) => void openRow(selected, true)}
              onOpenSettings={() => void openRow(settingsRow, true)}
            />
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
                resolve={(nativeId) => session.resolveContact(nativeId)}
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
