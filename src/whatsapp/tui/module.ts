import {
  defineModule,
  rejectAction,
  type PanelDefinition,
  type TuiAppScope,
  type TuiModuleDefinition,
  type WindowManager,
} from "agentic-tui-kit";
import { defineWhatsAppActions, type WhatsAppActions } from "../actions";
import type { WhatsAppSessionController } from "../session/controller";
import { defineWhatsAppPanel } from "./panel";
import type { WhatsAppTarget } from "./route";

export interface WhatsAppModule {
  readonly module: TuiModuleDefinition;
  readonly panel: PanelDefinition<WhatsAppTarget>;
  readonly actions: WhatsAppActions;
  /**
   * Hand the module the runtime's window manager.
   *
   * @remarks
   * Called from `createTuiAppRuntime`'s `configure` hook, which is the first
   * moment the manager exists. Until then the routing actions reject rather
   * than reach for a manager that is not there — an unmounted workbench is an
   * expected state for an agent to hit, not a crash.
   */
  bind(scope: TuiAppScope): void;
}

export function createWhatsAppModule(session: WhatsAppSessionController): WhatsAppModule {
  let windows: WindowManager | null = null;
  const panel = defineWhatsAppPanel(session);
  const actions = defineWhatsAppActions(
    session,
    () => {
      if (!windows) rejectAction("unavailable", "the workbench is not mounted yet");
      return windows;
    },
    panel,
  );

  const module = defineModule({
    id: "whatsapp",
    panels: [panel],
    actions: [
      actions.connect,
      actions.disconnect,
      actions.reconnect,
      actions.unlink,
      actions.openChat,
      actions.openSettings,
      actions.listChats,
      actions.send,
      actions.loadOlder,
      actions.markRead,
    ],
    dispose: () => {
      windows = null;
    },
  });

  return {
    module,
    panel,
    actions,
    bind: (scope) => {
      windows = scope.windows;
    },
  };
}
