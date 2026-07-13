import { describe, expect, it } from "vitest";

import type { GitHubWebhookDelivery } from "@flue/github";

import { createGitHubIngress, loadGitHubIngressSettings } from "../../src/github/ingress.ts";
import { createGitHubIngressStore } from "../../src/github/ingress-store.ts";

describe("GitHub ingress configuration", () => {
  it("loads explicit repository ownership without guessing case-sensitive GitHub identity", () => {
    const settings = loadGitHubIngressSettings({
      GITHUB_WEBHOOK_SECRET: "secret",
      GITHUB_CHAT_ROUTES: "Acme/Widgets=chat-a@g.us,acme/other=chat-b@g.us",
      GITHUB_INGRESS_DB_PATH: ":memory:",
    });

    expect(settings.routes).toEqual(
      new Map([
        ["acme/widgets", "chat-a@g.us"],
        ["acme/other", "chat-b@g.us"],
      ]),
    );
    expect(settings.databasePath).toBe(":memory:");
  });

  it("fails closed without a secret or any repository-to-chat ownership", () => {
    expect(() => loadGitHubIngressSettings({ GITHUB_CHAT_ROUTES: "acme/widgets=chat@g.us" })).toThrow(
      "GITHUB_WEBHOOK_SECRET",
    );
    expect(() => loadGitHubIngressSettings({ GITHUB_WEBHOOK_SECRET: "secret" })).toThrow(
      "At least one GitHub chat route",
    );
  });
});

describe("GitHub ingress delivery ledger", () => {
  it("atomically claims a delivery identifier only once and persists correlation", () => {
    const store = createGitHubIngressStore(":memory:");
    try {
      expect(store.claim("delivery-29", "issues", "2026-07-13T00:00:00.000Z")).toBe(true);
      expect(store.claim("delivery-29", "issues", "2026-07-13T00:00:01.000Z")).toBe(false);

      store.settle("delivery-29", {
        status: "dispatched",
        repository: "acme/widgets",
        chatId: "chat-29@g.us",
        ambience: "ambience",
        dispatchId: "dispatch-29",
        settledAt: "2026-07-13T00:00:02.000Z",
      });

      expect(store.get("delivery-29")).toEqual({
        deliveryId: "delivery-29",
        eventName: "issues",
        repository: "acme/widgets",
        chatId: "chat-29@g.us",
        ambience: "ambience",
        dispatchId: "dispatch-29",
        status: "dispatched",
        receivedAt: "2026-07-13T00:00:00.000Z",
        settledAt: "2026-07-13T00:00:02.000Z",
      });
    } finally {
      store.close();
    }
  });

  it("surfaces an interrupted claim as uncertain without blind redispatch", async () => {
    const store = createGitHubIngressStore(":memory:");
    try {
      store.claim("interrupted-29", "issues", "2026-07-13T00:00:00.000Z");
      let admissions = 0;
      const ingress = createGitHubIngress({
        store,
        routes: new Map([["acme/widgets", "chat-29@g.us"]]),
        admit: async () => {
          admissions += 1;
          return { dispatchId: "must-not-dispatch", acceptedAt: "2026-07-13T00:00:00.000Z" };
        },
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
        now: () => new Date("2026-07-13T00:00:01.000Z"),
      });

      const result = await ingress({
        name: "issues",
        deliveryId: "interrupted-29",
        payload: { action: "opened" },
      } as GitHubWebhookDelivery);

      expect(result.status).toBe("uncertain");
      expect(admissions).toBe(0);
      expect(store.get("interrupted-29")).toMatchObject({
        status: "uncertain",
        error: "Earlier processing was interrupted with Ambience admission outcome unknown",
      });
      expect((await ingress({
        name: "issues",
        deliveryId: "interrupted-29",
        payload: { action: "opened" },
      } as GitHubWebhookDelivery)).status).toBe("uncertain");
      expect(admissions).toBe(0);
    } finally {
      store.close();
    }
  });
});
