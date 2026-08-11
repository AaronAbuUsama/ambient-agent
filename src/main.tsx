import { loadAppConfig } from "./app/config";
import { mountTerminal } from "./app/mount-terminal";

await mountTerminal(loadAppConfig());
