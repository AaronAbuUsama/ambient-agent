import { loadAppConfig } from "./app/config";
import { runAmbientProcess } from "./app/run";

await runAmbientProcess(loadAppConfig());
