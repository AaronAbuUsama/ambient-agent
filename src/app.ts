import { flue } from "@flue/runtime/routing";
import { Hono } from "hono";

import { dispatchAmbience } from "./ambience/dispatch.js";
import {
  configureIssueManagementRuntime,
  createIssueManagementPolicy,
  loadIssueManagementSettings,
} from "./capabilities/issue-management/runtime.js";
import { createIssueOperationStore } from "./capabilities/issue-management/operation-store.js";
import { loadGitHubIngressSettings } from "./github/ingress.js";
import { installGitHubIngressRuntime } from "./github/ingress-runtime.js";
import { createOctokitIssueRepository } from "./host/github-issue-repository.js";
import { getWhatsAppRuntimeStatus, startWhatsAppRuntime } from "./host/whatsapp-runtime.js";
import { takeManagedRuntimeDependencies, type ManagedRuntimeDependencies } from "./managed/runtime-dependencies.js";
import { connectPiChatGptSubscription } from "./model/pi-subscription.js";

export const createAmbientAgentApp = async ({ authentication }: ManagedRuntimeDependencies): Promise<Hono> => {
  const subscription = await connectPiChatGptSubscription({ authentication });
  const githubIngress = loadGitHubIngressSettings();
  installGitHubIngressRuntime(githubIngress, async (chatId, input) => await dispatchAmbience({ id: chatId, input }));
  const issueManagement = loadIssueManagementSettings();
  configureIssueManagementRuntime({
    repository: createOctokitIssueRepository(issueManagement.token),
    operations: createIssueOperationStore(issueManagement.operationDatabasePath),
    policy: createIssueManagementPolicy(issueManagement.defaultRepository, issueManagement.allowedRepositories),
  });

  const app = new Hono();
  app.get("/health", (context) => context.json({ ok: true, ...subscription, whatsapp: getWhatsAppRuntimeStatus() }));
  app.route("/", flue());

  const whatsapp = startWhatsAppRuntime();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const shutdown = () => {
      void whatsapp.stop().finally(() => {
        process.removeListener(signal, shutdown);
        process.kill(process.pid, signal);
      });
    };
    process.once(signal, shutdown);
  }

  return app;
};

export default await createAmbientAgentApp(takeManagedRuntimeDependencies());
