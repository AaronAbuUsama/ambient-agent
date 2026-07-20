import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { SandboxFactory } from "@flue/runtime";
import { local } from "@flue/runtime/node";

import { E2B_WORKSPACES_ROOT, e2bSandbox } from "./e2b-sandbox.ts";
import type { ManagedPaths } from "./paths.ts";
import type { ManagedConfig } from "./schema.ts";

/**
 * One job's whole sandbox budget (ADR 0021): E2B keeps the micro-VM alive this long, and it
 * bounds any shell command whose caller names no shorter deadline. Comfortably over the Coder's
 * 20-minute per-command ceiling so a full implement→verify loop fits in one sandbox.
 */
const AGENT_SANDBOX_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * The per-job agent sandbox and the workspace root repos are extracted into, resolved **together**
 * (#251). They cannot be resolved apart: `E2B_WORKSPACES_ROOT` (`/home/user/...`) is a path inside
 * the E2B micro-VM and does not exist on a host, so the `local` sandbox must pair with the host's
 * `paths.workspaces` while `e2b` pairs with its in-VM root.
 */
export interface AgentSandbox {
  readonly sandbox: SandboxFactory;
  readonly workspacesRoot: string;
}

/**
 * Resolve the configured agent sandbox and its workspace root (#251). This is the selector the
 * one-box plan builds so `local | e2b` is a config choice, not a hardcoded binding — replacing the
 * old `E2B_API_KEY`-keyed `resolveAgentSandbox` that returned `undefined` (and silently disabled
 * both Specialists) whenever the key was absent.
 *
 * `local` is the default (D-1: attended single-operator use, the model's shell runs on the host as
 * the runtime uid). Its `TMPDIR` is workspace-local (#172): a hardened host may mount `/tmp`
 * `noexec`, which fails `EACCES` when the model spawns a binary out of the temp directory — the
 * recorded cause of the Coder green path never once completing — so point `TMPDIR` at the workspaces
 * tree and create it before the first command names it. Kept at the workspaces root rather than
 * under a job directory so a per-job cleanup never destroys it.
 *
 * `e2b` reads `E2B_API_KEY` and threads it **explicitly** into `Sandbox.create` rather than leaving
 * the SDK to read it from the ambient environment; the key stays operator environment until #252
 * moves it into `credentials/e2b.json`. Selecting `e2b` without a key throws here, so the runtime
 * exits non-zero at start rather than booting with a dead Coder — the sandbox-misconfigured negative.
 */
export const resolveAgentSandbox = async (
  config: ManagedConfig,
  paths: ManagedPaths,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<AgentSandbox> => {
  const { kind, template } = config.runtime.sandbox;
  if (kind === "e2b") {
    const apiKey = environment.E2B_API_KEY?.trim();
    if (!apiKey) {
      throw new Error(
        "runtime.sandbox.kind is e2b but E2B_API_KEY is not set. Set it, or run ambient-agent config --sandbox local.",
      );
    }
    return {
      sandbox: e2bSandbox({
        timeoutMs: AGENT_SANDBOX_TIMEOUT_MS,
        apiKey,
        ...(template === undefined ? {} : { template }),
      }),
      workspacesRoot: E2B_WORKSPACES_ROOT,
    };
  }
  const tmpDir = join(paths.workspaces, ".tmp");
  await mkdir(tmpDir, { recursive: true });
  return {
    sandbox: local({ env: { TMPDIR: tmpDir } }),
    workspacesRoot: paths.workspaces,
  };
};
