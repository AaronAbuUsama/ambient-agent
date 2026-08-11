import type { PanelDefinition, WindowManager } from "agentic-tui-kit";
import type { WhatsAppSessionController } from "../session/controller";
import type { WhatsAppTarget } from "../tui/route";
import { defineChatQueryActions } from "./chats";
import { defineConnectionActions } from "./connection";
import { defineMessagingActions } from "./messaging";
import { defineNavigationActions } from "./navigation";
import type { WhatsAppActions } from "./types";

export type { WhatsAppActions } from "./types";

/**
 * @param resolveWindows - The live {@link WindowManager}, read at invocation
 * rather than construction: module actions are registered before the runtime
 * hands out its scope, so a routing action cannot close over the manager it
 * needs at definition time.
 */
export function defineWhatsAppActions(
  session: WhatsAppSessionController,
  resolveWindows: () => WindowManager,
  panel: PanelDefinition<WhatsAppTarget>,
): WhatsAppActions {
  return {
    ...defineConnectionActions(session),
    ...defineNavigationActions(session, resolveWindows, panel),
    ...defineChatQueryActions(session),
    ...defineMessagingActions(session),
  };
}
