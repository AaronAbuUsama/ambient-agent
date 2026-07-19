import { Hono } from "hono";

import { bridgeHealth } from "@ambient-agent/installation/bridge-contract.ts";
import type { TenantRuntimeSetupBoot } from "@ambient-agent/installation/runtime-dependencies.ts";
import { installBridgeRoute } from "./host/bridge-route.ts";
import { startWhatsAppSetupRuntime, type WhatsAppSetupRuntime } from "./host/whatsapp-setup-runtime.ts";

interface SetupRuntimeServices {
  readonly startWhatsApp: typeof startWhatsAppSetupRuntime;
}

const stopWhatsAppOnSignal = (whatsapp: WhatsAppSetupRuntime): void => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const shutdown = () => {
      void whatsapp.stop().finally(() => {
        process.removeListener(signal, shutdown);
        process.kill(process.pid, signal);
      });
    };
    process.once(signal, shutdown);
  }
};

export const createAmbientAgentSetupApp = (
  boot: TenantRuntimeSetupBoot,
  services: SetupRuntimeServices = { startWhatsApp: startWhatsAppSetupRuntime },
): Hono => {
  let whatsapp: WhatsAppSetupRuntime | undefined;
  const startOnce = (): void => {
    if (whatsapp !== undefined) return;
    whatsapp = services.startWhatsApp({
      storeDirectory: boot.paths.whatsapp,
      credentialEnvironment: boot.credentialEnvironment,
    });
    stopWhatsAppOnSignal(whatsapp);
  };
  const status = () => whatsapp?.status() ?? { phase: "disabled" as const };
  const app = new Hono();
  app.use("*", async (_context, next) => {
    startOnce();
    await next();
  });
  app.get("/health", (context) => context.json(bridgeHealth(boot.runtimeId, status())));
  installBridgeRoute(app, {
    webhookSecret: boot.bridgeSecret,
    status,
    control: () => whatsapp,
  });
  return app;
};
