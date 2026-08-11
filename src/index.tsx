import {
  createTerminalHost,
  createTuiAppRuntime,
  TuiAppShell,
  type TuiAppRuntime,
} from "agentic-tui-kit";
import { createWhatsAppWorkbench } from "./app";
import { captureStrayOutput } from "./log";
import { deploymentPaths, localDeployment } from "./whatsapp/deployment";

const accountId = process.env.WHATSAPP_ACCOUNT_ID ?? "main";
const paths = deploymentPaths();
const workbench = createWhatsAppWorkbench(localDeployment(accountId));

let runtime: TuiAppRuntime | undefined;
let releaseOutput: (() => void) | undefined;
let cleaning = false;

const cleanup = async () => {
  if (cleaning) return;
  cleaning = true;
  // Disposing the runtime disposes the module, which disposes the engine —
  // Client, then Runtime, then the libSQL handle, in that order.
  runtime?.dispose();
  await workbench.engine.dispose();
  // Last, so anything the teardown prints reaches the human rather than the log.
  releaseOutput?.();
};

const terminal = await createTerminalHost({ onDestroy: cleanup });
// After the host, never before: the renderer captures the real `write` at
// construction and pushes frames through it, so a wrapper installed now diverts
// stray library output without touching the UI.
releaseOutput = captureStrayOutput(paths.logFile);
try {
  runtime = createTuiAppRuntime(workbench.app, {
    ...workbench.runtimeOptions,
    quit: () => terminal.destroy(),
  });
  terminal.render(<TuiAppShell runtime={runtime} />);
  // Claim the account immediately: a workbench that opens disconnected makes
  // the human press Connect before anything it exists to show can appear.
  void runtime.invokeId(
    "whatsapp.connect",
    {},
    { actor: { kind: "system", id: "startup" }, source: "system" },
  );
} catch (error) {
  terminal.destroy();
  await cleanup();
  throw error;
}
