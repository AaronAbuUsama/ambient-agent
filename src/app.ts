import { getRun } from "@flue/runtime";
import { flue } from "@flue/runtime/routing";
import { Hono } from "hono";

import { dispatchAmbience } from "./ambience/doorway.js";
import {
  createGitHubProofPolicy,
  configureGitHubProofRuntime,
  loadGitHubProofSettings,
} from "./github/proof-runtime.js";
import { createOctokitGitHubProofHost } from "./host/github-proof-host.js";
import { connectPiChatGptSubscription } from "./model/pi-subscription.js";
import {
  configureGitHubProofResultSink,
  installGitHubProofResultDelivery,
} from "./workflows/github-proof.js";

const subscription = await connectPiChatGptSubscription();
const github = loadGitHubProofSettings();
configureGitHubProofRuntime({
  host: createOctokitGitHubProofHost(github.token),
  policy: createGitHubProofPolicy(github.defaultRepository, github.allowedRepositories),
});
configureGitHubProofResultSink(async (chatId, input) => {
  const run = await getRun(input.runId);
  const expectedStatus = input.type === "workflow.failed" ? "errored" : "completed";
  if (run?.status !== expectedStatus) {
    throw new Error(`GitHub proof workflow ${input.runId} is not durably ${expectedStatus}`);
  }
  await dispatchAmbience({ id: chatId, input });
});
installGitHubProofResultDelivery();

const app = new Hono();
app.get("/health", (context) => context.json({ ok: true, ...subscription }));
app.route("/", flue());

export default app;
