import { errorMessage } from "@ambient-agent/engine/shared/errors.ts";
import { upstreamWhatsAppLogger } from "@ambient-agent/engine/logging/logging.ts";
import type { TenantCredentialEnvironment } from "@ambient-agent/installation/tenant-credentials.ts";
import type { WhatsAppRuntimeStatus } from "@ambient-agent/installation/runtime-health.ts";
import { createWhatsAppAccount, type ManagedWhatsAppAccount } from "@ambient-agent/installation/whatsapp-account.ts";

export interface WhatsAppSetupRuntimeOptions {
  readonly storeDirectory: string;
  readonly credentialEnvironment: Required<TenantCredentialEnvironment>;
}

export interface WhatsAppSetupRuntime {
  readonly status: () => WhatsAppRuntimeStatus;
  readonly synchronizedChats: ManagedWhatsAppAccount["synchronizedChats"];
  readonly stop: () => Promise<void>;
}

interface WhatsAppSetupRuntimeServices {
  readonly createAccount: typeof createWhatsAppAccount;
}

/**
 * Own one WhatsApp account for setup only. This host intentionally has no
 * Conversation Archive, Managed Chat inbox, Coalescer, Speaker, or stdout pairing UI.
 */
export const startWhatsAppSetupRuntime = (
  options: WhatsAppSetupRuntimeOptions,
  services: WhatsAppSetupRuntimeServices = { createAccount: createWhatsAppAccount },
): WhatsAppSetupRuntime => {
  let status: WhatsAppRuntimeStatus = { phase: "starting" };
  let stopping = false;
  const account = services.createAccount({
    storeDirectory: options.storeDirectory,
    environment: options.credentialEnvironment,
    logger: upstreamWhatsAppLogger(),
    archive: { append: () => false },
  });
  const authentication = Promise.resolve()
    .then(
      async () =>
        await account.authenticate({
          onPairing: (pairing) => {
            if (!stopping) status = { phase: "pairing", pairing };
          },
        }),
    )
    .then(() => {
      if (!stopping) status = { phase: "online" };
    })
    .catch((cause: unknown) => {
      if (!stopping) status = { phase: "failed", error: errorMessage(cause) };
    });
  void authentication;

  return {
    status: () => structuredClone(status),
    synchronizedChats: async (signal) => await account.synchronizedChats(signal),
    stop: async () => {
      stopping = true;
      await account.stop();
      status = { phase: "stopped" };
    },
  };
};
