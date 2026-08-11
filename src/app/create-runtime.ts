import {
  createTuiAppRuntime,
  type CreateTuiAppRuntimeOptions,
  type TuiAppRuntime,
} from "agentic-tui-kit";
import type { WhatsAppSessionOptions } from "../whatsapp/session/controller";
import { createWhatsAppWorkbench, type WhatsAppWorkbench } from "./create-workbench";

export interface AmbientRuntime {
  readonly workbench: WhatsAppWorkbench;
  readonly tui: TuiAppRuntime;
  dispose(): Promise<void>;
}

/**
 * Create the semantic application runtime without mounting a terminal.
 *
 * Humans, agents, systems, and tests can all invoke the returned action
 * registry. A terminal host is only one optional renderer over this runtime.
 */
export function createAmbientRuntime(
  whatsapp: WhatsAppSessionOptions,
  options: Omit<CreateTuiAppRuntimeOptions, "configure"> = {},
): AmbientRuntime {
  const workbench = createWhatsAppWorkbench(whatsapp);
  const tui = createTuiAppRuntime(workbench.app, {
    ...options,
    ...workbench.runtimeOptions,
  });
  let disposing: Promise<void> | undefined;

  return {
    workbench,
    tui,
    dispose: () => {
      disposing ??= (async () => {
        tui.dispose();
        await workbench.session.dispose();
      })();
      return disposing;
    },
  };
}
