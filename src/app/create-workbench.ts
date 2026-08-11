import {
  defineTuiApp,
  openPanel,
  type CreateTuiAppRuntimeOptions,
  type TuiAppDefinition,
} from "agentic-tui-kit";
import {
  WhatsAppSessionController,
  type WhatsAppSessionOptions,
} from "../whatsapp/session/controller";
import { createWhatsAppModule, type WhatsAppModule } from "../whatsapp/tui/module";
import { settingsTarget } from "../whatsapp/tui/route";

export interface WhatsAppWorkbench {
  readonly app: TuiAppDefinition;
  readonly session: WhatsAppSessionController;
  readonly whatsapp: WhatsAppModule;
  /**
   * Runtime options every host must pass.
   *
   * @remarks
   * The routing actions need the runtime's `WindowManager`, which does not
   * exist until `createTuiAppRuntime` builds it. Handing the caller the
   * `configure` hook that binds it — rather than hiding a second construction
   * path inside the app — keeps the local host, the headless journey, and any
   * other host on exactly one wiring.
   */
  readonly runtimeOptions: Pick<CreateTuiAppRuntimeOptions, "configure">;
}

/**
 * Compose the one-pane WhatsApp workbench.
 *
 * @param options - How this deployment stores the account and opens its
 * session. Production passes libSQL and a real QR session; a journey passes
 * in-memory stores and a deterministic session, and everything above this line
 * is identical.
 */
export function createWhatsAppWorkbench(options: WhatsAppSessionOptions): WhatsAppWorkbench {
  const session = new WhatsAppSessionController(options);
  const whatsapp = createWhatsAppModule(session);

  const app = defineTuiApp({
    id: "whatsapp",
    brand: "WHATSAPP",
    themeId: "green",
    modules: [whatsapp.module],
    initialWorkspaces: [
      {
        id: "main",
        name: "Main",
        // One workspace, one window: the account opens on its connection
        // screen, which is where pairing happens and where every chat is one
        // sidebar row away.
        open: [openPanel(whatsapp.panel, settingsTarget)],
      },
    ],
  });

  return {
    app,
    session,
    whatsapp,
    runtimeOptions: { configure: (scope) => whatsapp.bind(scope) },
  };
}
