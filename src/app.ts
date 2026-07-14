import { flue } from "@flue/runtime/routing";
import { Hono } from "hono";

import { dispatchAmbience } from "./ambience/dispatch.js";
import {
  createGitHubProofPolicy,
  configureGitHubProofRuntime,
  loadGitHubProofSettings,
} from "./github/proof-runtime.js";
import { loadGitHubIngressSettings } from "./github/ingress.js";
import { installGitHubIngressRuntime } from "./github/ingress-runtime.js";
import { createOctokitGitHubProofHost } from "./host/github-proof-host.js";
import { getWhatsAppRuntimeStatus, startWhatsAppRuntime } from "./host/whatsapp-runtime.js";
import { connectPiChatGptSubscription } from "./model/pi-subscription.js";
import { installGitHubProofResultDispatch } from "./workflows/github-proof.js";

const subscription = await connectPiChatGptSubscription();
const githubIngress = loadGitHubIngressSettings();
installGitHubIngressRuntime(githubIngress, async (chatId, input) => await dispatchAmbience({ id: chatId, input }));
const github = loadGitHubProofSettings();
configureGitHubProofRuntime({
  host: createOctokitGitHubProofHost(github.token),
  policy: createGitHubProofPolicy(github.defaultRepository, github.allowedRepositories),
});
installGitHubProofResultDispatch(async (chatId, input) => {
  await dispatchAmbience({ id: chatId, input });
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

export default app;
