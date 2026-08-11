import { defineAction, type PanelDefinition, type WindowManager } from "agentic-tui-kit";
import { z } from "zod";
import type { WhatsAppSessionController } from "../session/controller";
import { settingsTarget, type WhatsAppTarget } from "../tui/route";
import { requireChat } from "./guards";
import { whatsAppActions } from "./ids";
import { chatIdSchema, routeReceiptSchema } from "./types";

/**
 * Point the account's single window at one route.
 *
 * `WindowManager.reveal` matches on address, so navigating the existing window
 * preserves the deliberate one-pane workbench.
 */
function route(
  windows: WindowManager,
  panel: PanelDefinition<WhatsAppTarget>,
  target: WhatsAppTarget,
): z.infer<typeof routeReceiptSchema> {
  const open = windows.getSnapshot().windows.find((window) => window.type === panel.type);
  if (!open) {
    const windowId = windows.open(panel, target);
    return { windowId, address: windows.address(panel, target) };
  }
  windows.navigate(open.id, panel, target);
  windows.focus(open.id);
  return { windowId: open.id, address: windows.address(panel, target) };
}

export function defineNavigationActions(
  session: WhatsAppSessionController,
  resolveWindows: () => WindowManager,
  panel: PanelDefinition<WhatsAppTarget>,
) {
  const openChat = defineAction({
    id: whatsAppActions.openChat,
    title: "Open chat",
    group: "WhatsApp",
    description: "Point the workbench at one chat by its WhatsApp id.",
    inputSchema: z.object({ chatId: chatIdSchema }),
    outputSchema: routeReceiptSchema,
    sideEffect: "local-write",
    execute: ({ chatId }) => {
      requireChat(session, chatId);
      return route(resolveWindows(), panel, { view: "chat", chatId });
    },
  });

  const openSettings = defineAction({
    id: whatsAppActions.openSettings,
    title: "Open settings",
    group: "WhatsApp",
    description: "Point the workbench at the connection settings view.",
    inputSchema: z.object({}),
    outputSchema: routeReceiptSchema,
    sideEffect: "local-write",
    keybindings: [{ chord: { name: ",", ctrl: true }, input: {}, hint: "settings" }],
    paletteEntries: [{ title: "Open settings", input: {} }],
    execute: () => route(resolveWindows(), panel, settingsTarget),
  });

  return { openChat, openSettings };
}
