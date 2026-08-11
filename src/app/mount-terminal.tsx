import { createTerminalHost, TuiAppShell } from "agentic-tui-kit";
import { captureStrayOutput } from "../platform/logging";
import { deploymentPaths, localDeployment } from "../whatsapp/session/local-deployment";
import { whatsAppActions } from "../whatsapp/actions/ids";
import type { AppConfig } from "./config";
import { createAmbientRuntime, type AmbientRuntime } from "./create-runtime";

/** Mount the semantic Ambient runtime in the local full-screen terminal host. */
export async function mountTerminal(config: AppConfig): Promise<void> {
  const paths = deploymentPaths(config.whatsapp.dataDirectory);
  let ambient: AmbientRuntime | undefined;
  let releaseOutput: (() => void) | undefined;
  let cleaning: Promise<void> | undefined;

  const cleanup = (): Promise<void> => {
    cleaning ??= (async () => {
      await ambient?.dispose();
      // Last, so anything teardown prints reaches the log rather than the
      // full-screen terminal, then normal process output is restored.
      releaseOutput?.();
    })();
    return cleaning;
  };

  const terminal = await createTerminalHost({ onDestroy: cleanup });
  // The renderer captures the real output stream while it is constructed.
  // Installing this afterwards diverts library output without swallowing frames.
  releaseOutput = captureStrayOutput(paths.logFile);

  try {
    ambient = createAmbientRuntime(
      localDeployment({
        accountId: config.whatsapp.accountId,
        directory: config.whatsapp.dataDirectory,
        historyPrefetchLimit: config.whatsapp.historyPrefetchLimit,
        logLevel: config.logging.level,
      }),
      { quit: () => terminal.destroy() },
    );
    terminal.render(<TuiAppShell runtime={ambient.tui} />);
    // The account is an application resource, so the system claims it at
    // startup through the same action available to humans and agents.
    void ambient.tui.invokeId(
      whatsAppActions.connect,
      {},
      {
        actor: { kind: "system", id: "startup" },
        source: "system",
      },
    );
  } catch (error) {
    terminal.destroy();
    await cleanup();
    throw error;
  }
}
