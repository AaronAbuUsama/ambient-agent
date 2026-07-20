import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { resolveAgentSandbox } from "../../packages/installation/src/agent-sandbox.ts";
import { E2B_WORKSPACES_ROOT } from "../../packages/installation/src/e2b-sandbox.ts";
import { managedPaths } from "../../packages/installation/src/paths.ts";
import { createManagedConfig, type RuntimeSandbox } from "../../packages/installation/src/schema.ts";
import { parseSandboxKind } from "../../apps/cli/src/lifecycle.ts";

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const configWith = (sandbox: RuntimeSandbox) => ({
  ...createManagedConfig(["120363000@g.us"], "owner/repo"),
  runtime: { port: 3000, sandbox },
});

describe("resolveAgentSandbox (#251)", () => {
  it("resolves the local sandbox against the host workspaces and creates its TMPDIR before first use", async () => {
    const root = await mkdtemp(join(tmpdir(), "aa-sandbox-local-"));
    roots.push(root);
    const paths = managedPaths({ dataDirectory: root });

    const resolved = await resolveAgentSandbox(configWith({ kind: "local" }), paths, {});

    // The local sandbox pairs with the host workspaces root, not the E2B in-VM path.
    expect(resolved.workspacesRoot).toBe(paths.workspaces);
    expect(typeof resolved.sandbox.createSessionEnv).toBe("function");
    // The #172 workspace-local TMPDIR exists before any command names it, so a noexec /tmp
    // cannot fail the repo's install or tests.
    await expect(stat(join(paths.workspaces, ".tmp")).then((s) => s.isDirectory())).resolves.toBe(true);
  });

  it("resolves the e2b sandbox against its in-VM root when a key is present", async () => {
    const paths = managedPaths({ dataDirectory: "/nonexistent" });
    const resolved = await resolveAgentSandbox(configWith({ kind: "e2b" }), paths, { E2B_API_KEY: "e2b_test_key" });
    expect(resolved.workspacesRoot).toBe(E2B_WORKSPACES_ROOT);
    expect(typeof resolved.sandbox.createSessionEnv).toBe("function");
  });

  it("refuses to resolve when e2b is selected but no key is present — the sandbox-misconfigured negative", async () => {
    const paths = managedPaths({ dataDirectory: "/nonexistent" });
    // The throw is what makes the runtime exit non-zero at start rather than boot with a dead Coder.
    await expect(resolveAgentSandbox(configWith({ kind: "e2b" }), paths, {})).rejects.toThrow(/E2B_API_KEY/u);
    await expect(resolveAgentSandbox(configWith({ kind: "e2b" }), paths, { E2B_API_KEY: "  " })).rejects.toThrow(/E2B_API_KEY/u);
  });

  it("validates the --sandbox selector", () => {
    expect(parseSandboxKind("local")).toBe("local");
    expect(parseSandboxKind("e2b")).toBe("e2b");
    expect(() => parseSandboxKind("docker")).toThrow(/local or e2b/u);
  });
});
