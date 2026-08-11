import { PaneSidebar, PaneSidebarRow, useTheme } from "agentic-tui-kit";
import type { ChatRecord, ContactRecord, Status } from "whatsappd";
import { chatRowLabel, chatTitle, lastActivityStamp, statusLabel } from "./presentation";
import type { ChatFilter } from "./use-panel-controller";

export function ChatSidebar({
  width,
  height,
  panelFocused,
  keyboardFocused,
  selection,
  filter,
  chats,
  activeChatId,
  settingsActive,
  status,
  now,
  resolve,
  onCycleFilter,
  onOpenChat,
  onOpenSettings,
}: {
  width: number;
  height: number;
  panelFocused: boolean;
  keyboardFocused: boolean;
  selection: number;
  filter: ChatFilter;
  chats: readonly ChatRecord[];
  activeChatId: string | null;
  settingsActive: boolean;
  status: Status | null;
  now: number;
  resolve: (nativeId: string) => ContactRecord | undefined;
  onCycleFilter: () => void;
  onOpenChat: (chatId: string) => void;
  onOpenSettings: () => void;
}) {
  const { theme } = useTheme();

  return (
    <PaneSidebar
      width={width}
      height={height}
      focused={panelFocused}
      keyboardFocused={keyboardFocused}
      label="WhatsApp chats"
    >
      <box height={3} width={Math.max(1, width - 1)} paddingLeft={1} flexDirection="column">
        <text fg={theme.textBright}>
          <strong>CHATS</strong>
        </text>
        <text fg={status?.phase === "online" ? theme.positive : theme.warning}>
          {statusLabel(status)}
        </text>
        <box
          height={1}
          flexDirection="row"
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onCycleFilter();
          }}
          aria-label={`Filter chats: ${filter}`}
          data-app-role="chat-filter"
        >
          <text fg={theme.warning}>[f] </text>
          <text fg={filter === "all" ? theme.textDim : theme.textBright}>
            {`${filter} · ${chats.length}`}
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
          active={keyboardFocused ? selection === index : activeChatId === chat.chatId}
          label={chatRowLabel(
            `${chat.isGroup ? "#" : "@"} ${chatTitle(chat, resolve)}`,
            lastActivityStamp(chat.lastMessageAt, now),
            Math.max(1, width - 3),
          )}
          role="chat"
          onSelect={() => onOpenChat(chat.chatId)}
        />
      ))}

      <box flexGrow={1} />
      <PaneSidebarRow
        active={keyboardFocused ? selection === chats.length : settingsActive}
        label="⚙ Settings"
        role="settings"
        onSelect={onOpenSettings}
      />
    </PaneSidebar>
  );
}
