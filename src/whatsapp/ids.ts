/**
 * The action ids the workbench's controls invoke.
 *
 * @remarks
 * A view cannot import the action handles: the actions need the panel
 * definition to route the single window, and the panel needs the actions to
 * drive its controls. The id is the contract that breaks the cycle, and naming
 * it once here is what keeps a renamed action from silently becoming an
 * `unknown_action` rejection at one call site.
 */
export const whatsAppActions = {
  connect: "whatsapp.connect",
  disconnect: "whatsapp.disconnect",
  reconnect: "whatsapp.reconnect",
  unlink: "whatsapp.unlink",
  openChat: "whatsapp.open-chat",
  openSettings: "whatsapp.open-settings",
  listChats: "whatsapp.list-chats",
  send: "whatsapp.send",
  loadOlder: "whatsapp.load-older",
  markRead: "whatsapp.mark-read",
} as const;
