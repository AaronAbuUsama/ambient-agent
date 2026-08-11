import {
  defineAction,
  rejectAction,
  type ActionHandle,
  type PanelDefinition,
  type WindowManager,
} from "agentic-tui-kit";
import { z } from "zod";
import { chatTitle, statusLabel } from "./display";
import { whatsAppActions } from "./ids";
import type { WhatsAppEngine } from "./engine";
import { settingsTarget, type WhatsAppTarget } from "./target";

const chatId = z.string().trim().min(1);
const attachmentSchema = z.object({
  attachment: z.enum(["detached", "attaching", "attached", "detaching"]),
  status: z.string(),
});
const routeSchema = z.object({ windowId: z.string().min(1), address: z.string().min(1) });

/**
 * Point the account's single window at one route.
 *
 * @remarks
 * `WindowManager.reveal` matches on address, so revealing a second chat while a
 * first is open would leave two windows on screen. This workbench is deliberately
 * one pane: an existing window of this type is *navigated*, and a window is
 * opened only when none exists at all.
 */
function route(
  windows: WindowManager,
  panel: PanelDefinition<WhatsAppTarget>,
  target: WhatsAppTarget,
): z.infer<typeof routeSchema> {
  const open = windows.getSnapshot().windows.find((window) => window.type === panel.type);
  if (!open) {
    const windowId = windows.open(panel, target);
    return { windowId, address: windows.address(panel, target) };
  }
  windows.navigate(open.id, panel, target);
  windows.focus(open.id);
  return { windowId: open.id, address: windows.address(panel, target) };
}

export interface WhatsAppActions {
  readonly connect: ActionHandle<Record<string, never>, z.infer<typeof attachmentSchema>>;
  readonly disconnect: ActionHandle<Record<string, never>, z.infer<typeof attachmentSchema>>;
  readonly reconnect: ActionHandle<Record<string, never>, z.infer<typeof attachmentSchema>>;
  readonly unlink: ActionHandle<Record<string, never>, { unlinked: true }>;
  readonly openChat: ActionHandle<{ chatId: string }, z.infer<typeof routeSchema>>;
  readonly openSettings: ActionHandle<Record<string, never>, z.infer<typeof routeSchema>>;
  readonly listChats: ActionHandle<
    Record<string, never>,
    Array<{ chatId: string; title: string; isGroup: boolean; lastMessageAt: number }>
  >;
  readonly send: ActionHandle<
    { chatId: string; text: string },
    { operationId: string; chatId: string }
  >;
  readonly loadOlder: ActionHandle<{ chatId: string }, { chatId: string; older: string }>;
  readonly markRead: ActionHandle<{ chatId: string }, { chatId: string; marked: number }>;
}

/**
 * @param resolveWindows - The live {@link WindowManager}, read at invocation
 * rather than construction: module actions are registered before the runtime
 * hands out its scope, so a routing action cannot close over the manager it
 * needs at definition time.
 */
export function defineWhatsAppActions(
  engine: WhatsAppEngine,
  resolveWindows: () => WindowManager,
  panel: PanelDefinition<WhatsAppTarget>,
): WhatsAppActions {
  const receipt = () => {
    const { attachment, status } = engine.getSnapshot();
    return { attachment, status: statusLabel(status) };
  };

  const requireAttached = () => {
    const snapshot = engine.getSnapshot();
    if (snapshot.attachment !== "attached") {
      rejectAction("unavailable", `not connected (${snapshot.attachment})`);
    }
    return snapshot;
  };

  const requireChat = (requested: string) => {
    const chat = engine.getSnapshot().chats.find((candidate) => candidate.chatId === requested);
    if (!chat) rejectAction("not_found", `chat not found: ${requested}`);
    return chat;
  };

  const connect = defineAction({
    id: whatsAppActions.connect,
    title: "Connect WhatsApp",
    group: "WhatsApp",
    description:
      "Claim the account, open the WhatsApp session, and follow it. Shows a pairing QR when no linked credentials are stored.",
    inputSchema: z.object({}),
    outputSchema: attachmentSchema,
    sideEffect: "external-write",
    paletteEntries: [{ title: "Connect WhatsApp", input: {} }],
    available: () =>
      engine.getSnapshot().attachment === "detached" || "already connecting or connected",
    execute: async () => {
      await engine.attach();
      return receipt();
    },
  });

  const disconnect = defineAction({
    id: whatsAppActions.disconnect,
    title: "Disconnect WhatsApp",
    group: "WhatsApp",
    description: "Close the session and release the account, keeping stored credentials.",
    inputSchema: z.object({}),
    outputSchema: attachmentSchema,
    sideEffect: "external-write",
    paletteEntries: [{ title: "Disconnect WhatsApp", input: {} }],
    available: () => engine.getSnapshot().attachment !== "detached" || "already disconnected",
    execute: async () => {
      await engine.detach();
      return receipt();
    },
  });

  const reconnect = defineAction({
    id: whatsAppActions.reconnect,
    title: "Reconnect WhatsApp",
    group: "WhatsApp",
    description: "Release the account and claim it again with a fresh session.",
    inputSchema: z.object({}),
    outputSchema: attachmentSchema,
    sideEffect: "external-write",
    paletteEntries: [{ title: "Reconnect WhatsApp", input: {} }],
    execute: async () => {
      await engine.detach();
      await engine.attach();
      return receipt();
    },
  });

  const unlink = defineAction({
    id: whatsAppActions.unlink,
    title: "Unlink this device",
    group: "WhatsApp",
    description:
      "Disconnect and erase stored credentials so the next connection pairs a new device. The phone still lists the old device until it is removed there.",
    inputSchema: z.object({}),
    outputSchema: z.object({ unlinked: z.literal(true) }),
    sideEffect: "destructive",
    paletteEntries: [{ title: "Unlink this device", input: {} }],
    execute: async () => {
      await engine.forget();
      return { unlinked: true as const };
    },
  });

  const openChat = defineAction({
    id: whatsAppActions.openChat,
    title: "Open chat",
    group: "WhatsApp",
    description: "Point the workbench at one chat by its WhatsApp id.",
    inputSchema: z.object({ chatId }),
    outputSchema: routeSchema,
    sideEffect: "local-write",
    execute: ({ chatId: requested }) => {
      requireChat(requested);
      return route(resolveWindows(), panel, { view: "chat", chatId: requested });
    },
  });

  const openSettings = defineAction({
    id: whatsAppActions.openSettings,
    title: "Open settings",
    group: "WhatsApp",
    description: "Point the workbench at the connection settings view.",
    inputSchema: z.object({}),
    outputSchema: routeSchema,
    sideEffect: "local-write",
    keybindings: [{ chord: { name: ",", ctrl: true }, input: {}, hint: "settings" }],
    paletteEntries: [{ title: "Open settings", input: {} }],
    execute: () => route(resolveWindows(), panel, settingsTarget),
  });

  const listChats = defineAction({
    id: whatsAppActions.listChats,
    title: "List chats",
    group: "WhatsApp",
    description: "List the chats held in the local mirror, newest activity first.",
    inputSchema: z.object({}),
    outputSchema: z.array(
      z.object({
        chatId: z.string(),
        title: z.string(),
        isGroup: z.boolean(),
        lastMessageAt: z.number(),
      }),
    ),
    sideEffect: "local-read",
    execute: () =>
      [...engine.getSnapshot().chats]
        .sort((left, right) => right.lastMessageAt - left.lastMessageAt)
        .map((chat) => ({
          chatId: chat.chatId,
          title: chatTitle(chat, (nativeId) => engine.resolveContact(nativeId)),
          isGroup: chat.isGroup,
          lastMessageAt: chat.lastMessageAt,
        })),
  });

  const send = defineAction({
    id: whatsAppActions.send,
    title: "Send message",
    group: "WhatsApp",
    description:
      "Queue a durable text message to one chat. The receipt names the operation; delivery is reported separately.",
    inputSchema: z.object({ chatId, text: z.string().trim().min(1) }),
    outputSchema: z.object({ operationId: z.string().min(1), chatId: z.string().min(1) }),
    sideEffect: "external-write",
    available: () =>
      engine.getSnapshot().attachment === "attached" || "connect before sending messages",
    execute: async ({ chatId: requested, text }) => {
      requireAttached();
      const operation = await engine.sendText(requested, text);
      return { operationId: operation.id, chatId: requested };
    },
  });

  const loadOlder = defineAction({
    id: whatsAppActions.loadOlder,
    title: "Load earlier messages",
    group: "WhatsApp",
    description:
      "Read one older page from the local mirror. A background walk already does this for every chat, so this is the way to reach past the memory limit it stops at. The returned `older` reports the mirror only: nothing older stored here never means the phone has no more.",
    inputSchema: z.object({ chatId }),
    outputSchema: z.object({ chatId: z.string(), older: z.string() }),
    sideEffect: "local-write",
    execute: ({ chatId: requested }) => {
      requireAttached();
      engine.loadOlder(requested);
      return { chatId: requested, older: engine.chatMessages(requested)?.older ?? "loading" };
    },
  });

  const markRead = defineAction({
    id: whatsAppActions.markRead,
    title: "Mark chat read",
    group: "WhatsApp",
    description: "Acknowledge every retained inbound message in one chat.",
    inputSchema: z.object({ chatId }),
    outputSchema: z.object({ chatId: z.string(), marked: z.number().int().nonnegative() }),
    sideEffect: "external-write",
    available: () =>
      engine.getSnapshot().attachment === "attached" || "connect before marking messages read",
    execute: async ({ chatId: requested }) => {
      requireAttached();
      const refs = (engine.chatMessages(requested)?.messages ?? [])
        .filter((message) => !message.fromMe)
        .map((message) => message.ref);
      await engine.markRead(refs);
      return { chatId: requested, marked: refs.length };
    },
  });

  return {
    connect,
    disconnect,
    reconnect,
    unlink,
    openChat,
    openSettings,
    listChats,
    send,
    loadOlder,
    markRead,
  };
}
