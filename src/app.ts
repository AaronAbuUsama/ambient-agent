import { flue } from "@flue/runtime/routing";
import { Hono } from "hono";

import { dispatchAmbience } from "./ambience/dispatch.js";
import {
  configureIssueManagementRuntime,
  createIssueManagementPolicy,
} from "./capabilities/issue-management/runtime.js";
import { createIssueOperationStore } from "./capabilities/issue-management/operation-store.js";
import { installGitHubIngressRuntime } from "./github/ingress-runtime.js";
import { createOctokitIssueRepository } from "./host/github-issue-repository.js";
import {
  getWhatsAppRuntimeStatus,
  startWhatsAppRuntime,
  type WhatsAppRuntimeControl,
} from "./host/whatsapp-runtime.js";
import { installAgentActivityReporter } from "./logging/agent-activity-reporter.js";
import {
  deferWhatsAppRuntimeStart,
  getManagedRuntimeDependencies,
  type ManagedRuntimeDependencies,
} from "./managed/runtime-dependencies.js";
import {
  ambientRuntimeHealth,
  runtimeInstallationId,
  runtimeSmokeAuthorizationMatches,
} from "./managed/runtime-health.js";
import { connectPiChatGptSubscription } from "./model/pi-subscription.js";

export const createAmbientAgentApp = async ({
  authentication,
  configuration,
  githubCredential,
  paths,
}: ManagedRuntimeDependencies): Promise<Hono> => {
  installAgentActivityReporter();
  const subscription = await connectPiChatGptSubscription({ authentication });
  const issueOperations = createIssueOperationStore(paths.applicationDatabase);
  configureIssueManagementRuntime({
    repository: createOctokitIssueRepository(githubCredential.token),
    operations: issueOperations,
    policy: createIssueManagementPolicy(
      configuration.github.defaultRepository,
      configuration.github.allowedRepositories,
    ),
  });
  installGitHubIngressRuntime(
    {
      databasePath: paths.applicationDatabase,
      routes: new Map([[configuration.github.defaultRepository.toLowerCase(), configuration.managedChats[0]!]]),
    },
    async (chatId, input) => await dispatchAmbience({ id: chatId, input }),
    issueOperations,
  );

  const app = new Hono();
  const installationId = runtimeInstallationId(githubCredential.webhookSecret);
  let whatsappControl: WhatsAppRuntimeControl | undefined;
  app.get("/health", (context) => {
    const runtime = ambientRuntimeHealth(getWhatsAppRuntimeStatus());
    return context.json({
      ok: runtime.state === "healthy",
      installationId,
      ...subscription,
      runtime: { state: runtime.state, whatsapp: { phase: runtime.whatsapp.phase } },
    });
  });
  app.post("/smoke", async (context) => {
    const body = await context.req.json().catch(() => undefined);
    const nonce = (body as { readonly nonce?: unknown } | undefined)?.nonce;
    const timeoutMillis = (body as { readonly timeoutMillis?: unknown } | undefined)?.timeoutMillis;
    if (
      typeof nonce !== "string" ||
      !/^[A-Za-z0-9_-]{4,64}$/.test(nonce) ||
      !Number.isInteger(timeoutMillis) ||
      Number(timeoutMillis) < 1 ||
      Number(timeoutMillis) > 300_000
    ) {
      return context.json({ error: "invalid smoke canary request" }, 400);
    }
    if (
      !runtimeSmokeAuthorizationMatches(
        context.req.header("x-ambient-agent-smoke"),
        githubCredential.webhookSecret,
        nonce,
        Number(timeoutMillis),
      )
    ) {
      return context.json({ error: "smoke authorization rejected" }, 403);
    }
    if (configuration.smoke === undefined) {
      return context.json({ error: "no dedicated smoke canary group configured" }, 409);
    }
    if (whatsappControl === undefined) return context.json({ error: "WhatsApp runtime is not started" }, 503);
    try {
      return context.json(await whatsappControl.smokeCanary(nonce, Number(timeoutMillis)));
    } catch (cause) {
      return context.json({ error: cause instanceof Error ? cause.message : "live canary failed" }, 504);
    }
  });
  app.route("/", flue());

  // Deferred until the CLI observes a successful HTTP bind, so an occupied port
  // fails startup before WhatsApp ever connects (#87). For the instant between the
  // bind and the CLI invoking this starter, /health reports the WhatsApp phase as
  // "disabled"; every health consumer polls, so the window is harmless.
  deferWhatsAppRuntimeStart(() => {
    const whatsapp = startWhatsAppRuntime({
      storeDirectory: paths.whatsapp,
      applicationDatabase: paths.applicationDatabase,
      managedChats: configuration.managedChats,
      ...(configuration.smoke === undefined ? {} : { canaryChat: configuration.smoke.canaryChat }),
    });
    whatsappControl = whatsapp;
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const shutdown = () => {
        void whatsapp.stop().finally(() => {
          process.removeListener(signal, shutdown);
          process.kill(process.pid, signal);
        });
      };
      process.once(signal, shutdown);
    }
  });

  return app;
};

export default await createAmbientAgentApp(getManagedRuntimeDependencies());
