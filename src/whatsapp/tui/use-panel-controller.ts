import {
  humanKeyboardContext,
  humanPointerContext,
  systemContext,
  type ActionInvocationContext,
  type ActionRegistry,
  type ScrollBoxRenderable,
  type TextareaRenderable,
} from "agentic-tui-kit";
import { useEffect, useRef, useState } from "react";
import type { WhatsAppSessionController } from "../session/controller";
import { whatsAppActions } from "../actions/ids";
import type { WhatsAppTarget } from "./route";

export const settingsRow = "__settings__";
export const chatFilters = ["all", "direct", "groups"] as const;
export type ChatFilter = (typeof chatFilters)[number];

const initialHistoryPages = 4;

export function useWhatsAppPanelController({
  session,
  actions,
  target,
}: {
  session: WhatsAppSessionController;
  actions: ActionRegistry;
  target: WhatsAppTarget;
}) {
  const { view, chatId } = target;
  const [sidebarFocused, setSidebarFocused] = useState(false);
  const [sidebarSelection, setSidebarSelection] = useState(0);
  const [composerFocused, setComposerFocused] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ChatFilter>("all");
  const inputRef = useRef<TextareaRenderable | null>(null);
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const prefetched = useRef(new Map<string, number>());

  const allChats = [...session.getSnapshot().chats].sort(
    (left, right) => right.lastMessageAt - left.lastMessageAt,
  );
  const chats = allChats.filter(
    (chat) => filter === "all" || (filter === "groups") === chat.isGroup,
  );
  const rows = [...chats.map((chat) => chat.chatId), settingsRow];
  const draft = drafts[chatId] ?? "";
  const chatMessages = view === "chat" ? session.chatMessages(chatId) : null;

  const cycleFilter = () => {
    setSidebarSelection(0);
    setFilter((current) => chatFilters[(chatFilters.indexOf(current) + 1) % chatFilters.length]!);
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

  const openRow = (row: string, pointer = false) =>
    row === settingsRow
      ? run(whatsAppActions.openSettings, {}, pointer ? humanPointerContext : humanKeyboardContext)
      : run(
          whatsAppActions.openChat,
          { chatId: row },
          pointer ? humanPointerContext : humanKeyboardContext,
        );

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

  const pageable = chatMessages?.older === "stored";
  const held = chatMessages?.messages.length ?? 0;
  useEffect(() => {
    if (view !== "chat" || !pageable) return;
    const requested = held === 0 ? 0 : (prefetched.current.get(chatId) ?? 0);
    if (requested >= initialHistoryPages) return;
    prefetched.current.set(chatId, requested + 1);
    void actions.invokeId(whatsAppActions.loadOlder, { chatId }, systemContext);
  }, [actions, view, chatId, pageable, held]);

  return {
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
  };
}
