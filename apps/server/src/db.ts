import { sqlite } from "@flue/runtime/node";

import { getManagedRuntimeDependencies } from "@ambient-agent/station/runtime-dependencies.ts";

export const flueDatabasePath = (): string => getManagedRuntimeDependencies().paths.flueDatabase;

export default sqlite(flueDatabasePath());
