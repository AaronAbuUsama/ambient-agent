import { serve } from "@hono/node-server";

import { resolveTenantRuntimeSetupBoot } from "@ambient-agent/installation/runtime-dependencies.ts";
import { createAmbientAgentSetupApp } from "./setup-app.ts";

const boot = resolveTenantRuntimeSetupBoot();
const app = createAmbientAgentSetupApp(boot);

serve(
  {
    fetch: app.fetch,
    port: boot.port,
  },
  ({ port }) => {
    console.log(`Ambient Agent tenant setup is listening on port ${port}.`);
  },
);
