import { Buffer } from "node:buffer";

import type { Client } from "@libsql/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { runtimeInstallationId } from "../../packages/installation/src/runtime-health";

import {
  createHostedTenantProvisioner,
  startTenantProvisionerReconciliation,
} from "../../apps/api/src/provisioner-hosted";

afterEach(() => vi.useRealTimers());

describe("hosted tenant provisioner composition", () => {
  test("is disabled when no provider configuration is present", () => {
    expect(createHostedTenantProvisioner({ client: {} as Client, environment: {} })).toBeNull();
  });

  test("fails API startup on partial provider configuration", () => {
    expect(() =>
      createHostedTenantProvisioner({
        client: {} as Client,
        environment: { DOKPLOY_API_URL: "https://dokploy.example" },
      }),
    ).toThrow(/DOKPLOY_API_KEY/u);
  });

  test("builds the in-process reconciler only from a complete environment", () => {
    const provisioner = createHostedTenantProvisioner({
      client: {} as Client,
      environment: {
        DOKPLOY_API_URL: "https://dokploy.example",
        DOKPLOY_API_KEY: "dokploy-secret",
        DOKPLOY_ENVIRONMENT_ID: "environment-one",
        DOKPLOY_SERVER_ID: "server-one",
        DOKPLOY_WORKER_HOSTNAME: "worker-one",
        TENANT_RUNTIME_IMAGE: "ghcr.io/ambient/runtime:sha-one",
        TURSO_ORG: "ambient-org",
        TURSO_PLATFORM_TOKEN: "turso-secret",
        TENANT_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
        GITHUB_RUNTIME_DELIVERY_SECRETS_JSON: JSON.stringify({
          "tenant-one": "operate-runtime-secret",
        }),
      },
    });

    expect(provisioner).toMatchObject({
      reconcileTenant: expect.any(Function),
      reconcilePendingTenants: expect.any(Function),
      acknowledgeQuiescence: expect.any(Function),
      reconciliationIntervalMs: 5_000,
      operateRuntimeIdForTenant: expect.any(Function),
      runtimeBridgeSecretForTenant: expect.any(Function),
      runtimeIdForTenant: expect.any(Function),
    });
    expect(provisioner?.operateRuntimeIdForTenant("tenant-one")).toBe(
      runtimeInstallationId("operate-runtime-secret"),
    );
    expect(provisioner?.operateRuntimeIdForTenant("tenant-two")).toBeNull();
  });

  test("keeps sweeping later transitions without overlapping a slow sweep", async () => {
    vi.useFakeTimers();
    let releaseFirst: (() => void) | undefined;
    const firstSweep = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const reconcilePendingTenants = vi
      .fn<() => Promise<unknown>>()
      .mockReturnValueOnce(firstSweep)
      .mockResolvedValue([]);
    const loop = startTenantProvisionerReconciliation(
      { reconcilePendingTenants },
      { intervalMs: 1_000 },
    );

    expect(reconcilePendingTenants).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reconcilePendingTenants).toHaveBeenCalledTimes(1);
    releaseFirst?.();
    await firstSweep;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reconcilePendingTenants).toHaveBeenCalledTimes(2);

    loop.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reconcilePendingTenants).toHaveBeenCalledTimes(2);
  });
});
