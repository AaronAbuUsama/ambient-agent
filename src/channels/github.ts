import { createGitHubChannel } from "@flue/github";

import { handleGitHubDelivery } from "../github/ingress-runtime.js";

const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET?.trim();
if (!webhookSecret) throw new Error("GITHUB_WEBHOOK_SECRET is required for GitHub ingress");

// flue-blueprint: channel/github@1
export const channel = createGitHubChannel({
  webhookSecret,
  webhook: async ({ delivery }) => {
    const result = await handleGitHubDelivery(delivery);
    return new Response(JSON.stringify(result), {
      status: result.status === "uncertain" ? 409 : 200,
      headers: { "content-type": "application/json; charset=UTF-8" },
    });
  },
});
