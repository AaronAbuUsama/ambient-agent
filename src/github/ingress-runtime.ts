import type { GitHubWebhookDelivery } from "@flue/github";

import type { GitHubIngressResult } from "./ingress.js";

type GitHubIngressHandler = (delivery: GitHubWebhookDelivery) => Promise<GitHubIngressResult>;

let configured: GitHubIngressHandler | undefined;

export const configureGitHubIngressRuntime = (handler: GitHubIngressHandler): void => {
  configured = handler;
};

export const handleGitHubDelivery = (delivery: GitHubWebhookDelivery): Promise<GitHubIngressResult> => {
  if (!configured) throw new Error("GitHub ingress runtime is not configured");
  return configured(delivery);
};
