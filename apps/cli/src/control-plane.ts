/**
 * The control plane (#364): what `ambient-agent` with no subcommand is.
 *
 * One process holds two ports. The control plane binds its own, and stays bound for the life of
 * the process; the Flue runtime is then brought up *in the same process* through the dynamic
 * import seam in `lifecycle.ts`, and a runtime that cannot come up is captured as state the
 * control plane serves rather than an exception that kills the process. The operator's surface
 * must outlive the thing it exists to diagnose.
 *
 * Three contracts are defined here, and later work consumes them by name:
 *
 * - **The bearer-token scheme.** Every request carries `Authorization: Bearer <token>`; the token
 *   is minted once and persisted at `credentials/control-plane.json` (mode 0600). The gate runs
 *   *before* routing, so the control plane has no unauthenticated corner — not even a 404.
 * - **The route shape.** JSON under `/api/`; `GET /api/status` is the only route today. 401 with
 *   `WWW-Authenticate: Bearer` for a missing or wrong token, 404 for an unknown authorized path,
 *   405 for a wrong method.
 * - **The runtime-boot value.** {@link RuntimeBoot} — the in-process value the routes serve, and
 *   the single place a boot failure is recorded.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir } from "node:fs/promises";

import {
  atomicWriteManagedConfig,
  readManagedControlPlaneCredential,
} from "@ambient-agent/installation/configuration.ts";
import { inspectManagedData, type InstallationInspection } from "@ambient-agent/installation/installation.ts";
import { controlPlaneCredentialFrom } from "@ambient-agent/installation/schema.ts";
import type { ManagedPaths } from "@ambient-agent/installation/paths.ts";

import { acquireInstanceLock, type RuntimeLoggingOptions, type StartRuntime } from "./lifecycle.ts";
import type { CliOutput } from "./program.ts";

/** Deliberately not the runtime's 3000: one process, two ports, neither shadowing the other. */
export const DEFAULT_CONTROL_PLANE_PORT = 4747;

/**
 * Loopback only. This is the whole administrative surface of the installation, so it is reached
 * from the machine itself — a local browser, an SSH tunnel, a tunnel daemon — never straight off
 * the network on the strength of one bearer token.
 */
const CONTROL_PLANE_HOST = "127.0.0.1";

/**
 * How the in-process runtime boot went, as the control plane reports it (#364).
 *
 * `not-configured` is the no-installation answer the control plane must give instead of erroring;
 * `failed` is a boot that was attempted and threw, and it is terminal for this process — the
 * runtime is not retried behind the operator's back.
 */
export type RuntimeBoot =
  | { readonly phase: "not-configured"; readonly detail: string }
  | { readonly phase: "starting" }
  | { readonly phase: "running" }
  | { readonly phase: "failed"; readonly detail: string; readonly at: string };

export interface ControlPlaneStatus {
  readonly dataDirectory: string;
  readonly installation: InstallationInspection["state"];
  readonly runtime: RuntimeBoot;
}

export interface ControlPlaneOptions {
  readonly paths: ManagedPaths;
  readonly port: number;
  readonly logging: RuntimeLoggingOptions;
  readonly startRuntime: StartRuntime;
  readonly output: CliOutput;
  /** Closes the control plane; the process holds the port open until it aborts. */
  readonly signal?: AbortSignal;
}

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

const bearer = (header: string | undefined): string | undefined =>
  header?.slice(0, 7).toLowerCase() === "bearer " ? header.slice(7).trim() : undefined;

const respond = (
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void => {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(`${JSON.stringify(body)}\n`);
};

/** The token gate and the routes behind it. Exported for tests; `runControlPlane` binds it. */
export const createControlPlaneServer = (token: string, status: () => ControlPlaneStatus): Server => {
  const expected = digest(token);
  return createServer((request, response) => {
    const presented = bearer(request.headers.authorization);
    // The gate runs before routing, so an unknown path is refused exactly like a known one and
    // the token's length leaks nothing: both sides are compared as equal-width digests.
    if (presented === undefined || !timingSafeEqual(digest(presented), expected)) {
      return respond(response, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
    }
    const path = new URL(request.url ?? "/", `http://${CONTROL_PLANE_HOST}`).pathname;
    if (path !== "/api/status") return respond(response, 404, { error: "not-found" });
    if (request.method !== "GET" && request.method !== "HEAD") {
      return respond(response, 405, { error: "method-not-allowed" });
    }
    return respond(response, 200, status());
  });
};

/**
 * The persisted bearer token, minted on the first boot that has somewhere to keep it.
 *
 * ponytail: one token, one file, no rotation and no second secret — #365 folds it into the managed
 * secret store. An installation that does not exist yet has nowhere to persist to: minting the data
 * directory here would make `inspectManagedData` classify it `incomplete` and `ambient-agent init`
 * refuse to install into it, so an unconfigured control plane serves a process-lifetime token and
 * persists on the first boot after setup (#371 owns the first-run handoff).
 */
const controlPlaneToken = async (
  paths: ManagedPaths,
  persistable: boolean,
): Promise<{ readonly token: string; readonly persisted: boolean }> => {
  try {
    return { token: (await readManagedControlPlaneCredential(paths.controlPlaneCredential)).token, persisted: true };
  } catch (cause) {
    // Absent is first-boot. Anything else — malformed, unreadable, a symlink — fails closed:
    // silently minting a replacement over a damaged token file would revoke live access unasked.
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  const token = randomBytes(32).toString("base64url");
  if (!persistable) return { token, persisted: false };
  await mkdir(paths.credentials, { recursive: true, mode: 0o700 });
  await atomicWriteManagedConfig(paths.controlPlaneCredential, controlPlaneCredentialFrom(token));
  return { token, persisted: true };
};

const listen = async (server: Server, port: number): Promise<number> => {
  try {
    return await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, CONTROL_PLANE_HOST, () => {
        server.removeListener("error", reject);
        const address = server.address();
        if (address === null || typeof address === "string") {
          return reject(new Error("The control plane bound no TCP address."));
        }
        resolve(address.port);
      });
    });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new Error(
        `Control plane port ${port} is already in use; free it or run ambient-agent --control-port <port>.`,
        { cause },
      );
    }
    throw cause;
  }
};

/** The first diagnostic, as one operator-readable sentence. */
const explain = (inspection: InstallationInspection): string => {
  const [diagnostic] = inspection.diagnostics;
  return diagnostic === undefined
    ? `Managed data at ${inspection.dataDirectory} is ${inspection.state}.`
    : `${diagnostic.message} ${diagnostic.remediation}`;
};

/**
 * Bind the control plane, then bring the runtime up behind it. Resolves once the boot has been
 * attempted; the bound server keeps the process alive from there until `signal` aborts.
 */
export const runControlPlane = async (options: ControlPlaneOptions): Promise<void> => {
  const { output, paths, startRuntime } = options;
  const inspection = await inspectManagedData({ dataDirectory: paths.root });
  const installed = inspection.state !== "absent";
  // Before anything binds: one process, one data directory (#311). A second live process is
  // refused here, loudly, rather than quietly sharing the SQLite pair and the WhatsApp session.
  if (installed) await acquireInstanceLock(paths.root);
  const { token, persisted } = await controlPlaneToken(paths, installed);
  // The one mutable cell in the process: written only below, read only by the routes. #386's
  // observation seam is what turns it into something subscribable.
  let runtime: RuntimeBoot =
    inspection.state === "ready" ? { phase: "starting" } : { phase: "not-configured", detail: explain(inspection) };
  const server = createControlPlaneServer(token, () => ({
    dataDirectory: paths.root,
    installation: inspection.state,
    runtime,
  }));
  const port = await listen(server, options.port);
  options.signal?.addEventListener(
    "abort",
    () => {
      server.closeAllConnections();
      server.close();
    },
    { once: true },
  );
  output.stdout(`Control plane listening on http://${CONTROL_PLANE_HOST}:${port}\n`);
  // The token is handed over by file path, never echoed: stdout is journald's input under systemd,
  // and a token in the journal is a token in a log. The unpersisted first-run token has no file to
  // point at, so it is printed once — that installation has no logs directory yet either.
  output.stdout(
    persisted
      ? `Control plane bearer token: ${paths.controlPlaneCredential} (mode 0600).\n`
      : `Control plane bearer token, unpersisted until ${paths.root} exists: ${token}\n`,
  );
  if (inspection.state !== "ready") {
    output.stdout(`Runtime not started: ${explain(inspection)}\n`);
    return;
  }
  try {
    await startRuntime(paths, options.logging);
    runtime = { phase: "running" };
  } catch (cause) {
    // Captured, never fatal. The control plane is how the operator reads this failure and fixes
    // it; exiting here would take the diagnosis surface down with the thing being diagnosed.
    const detail = cause instanceof Error ? cause.message : String(cause);
    runtime = { phase: "failed", detail, at: new Date().toISOString() };
    output.stderr(`ambient-agent: the runtime did not start: ${detail}\n`);
  }
};
