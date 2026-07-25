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
 *   is minted once and persisted at `credentials/control-plane.json` (mode 0600). Under `/api/`
 *   the gate runs *before* routing, so an unknown API path is refused exactly like a known one.
 * - **The route shape.** JSON under `/api/`; `GET /api/status` for a point read, `GET /api/observe`
 *   for the live state and `GET /api/logs` for the live operator feed. 401 with
 *   `WWW-Authenticate: Bearer` for a missing or wrong token, 404 for an unknown authorized path,
 *   405 for a wrong method.
 * - **The runtime-boot value.** {@link RuntimeBoot} — the in-process value the routes serve, and
 *   the single place a boot failure is recorded.
 *
 * `GET /api/observe` is the delivery half of the observation seam (#386): an SSE stream that opens
 * with a `snapshot` event carrying every channel's current value, then sends one `delta` per
 * publication. Everything a browser needs to watch — runtime boot, WhatsApp liveness, setup
 * progress — reaches it through that one endpoint, so #371 and #374 do not each invent a transport.
 *
 * **#372 amends #364's gate, deliberately.** As merged, the gate ran before routing on *every*
 * path, so a browser arriving at `http://127.0.0.1:4747` got `{"error":"unauthorized"}` and the
 * console could never load. The static shell — `GET /` and everything under the built asset
 * directory — is now served **without** a bearer token; everything under `/api/`, including
 * `/api/observe`, keeps the gate exactly as merged. What is given up is "not even a 404 is
 * unauthenticated". What is preserved is the property that matters: no unauthenticated access to
 * *installation state*. The shell carries no data; it is an empty application that must
 * authenticate before it can show anything.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { operatorFeed, type OperatorFeedRecord } from "@ambient-agent/engine/logging/operator-feed.ts";
import { atomicWriteManagedConfig } from "@ambient-agent/installation/configuration.ts";
import { withManagedConfigurationSource } from "@ambient-agent/installation/configuration-source.ts";
import { inspectManagedData, type InstallationInspection } from "@ambient-agent/installation/installation.ts";
import { controlPlaneCredentialFrom } from "@ambient-agent/installation/schema.ts";
import {
  OBSERVATION_CHANNELS,
  observationSnapshot,
  observed,
  subscribeToAllObservations,
  type Observation,
  type Retained,
} from "@ambient-agent/installation/observation.ts";
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

/**
 * This process incarnation. `id` is minted per boot and cannot pre-exist the run, so a client can
 * tell "the value I hold is current" from "the process restarted under me and my state is from a
 * different run" — the one thing a snapshot alone cannot tell you.
 */
export interface InstanceIdentity {
  readonly id: string;
  readonly startedAt: string;
  readonly pid: number;
}

export interface ControlPlaneStatus {
  readonly instance: InstanceIdentity;
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
  /**
   * Whether a human is watching this terminal. It gates one thing: printing the first-run token
   * that has nowhere to be persisted. Under a service manager stdout *is* the log.
   */
  readonly interactive: boolean;
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

/** SSE keepalive. Long enough to be cheap, short enough that a dead proxy is noticed. */
const OBSERVE_HEARTBEAT_MS = 15_000;

/** Open an SSE response. Returns the sender, or undefined for a HEAD that wants headers only. */
const openEventStream = (
  response: ServerResponse,
  headersOnly: boolean,
): ((event: string, data: unknown) => void) | undefined => {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    // Any buffering proxy in front of this would defeat the point of a live stream.
    "x-accel-buffering": "no",
  });
  if (headersOnly) {
    response.end();
    return undefined;
  }
  return (event, data) => {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
};

/** Both streams keep the connection warm the same way, and neither holds the process open. */
const keepAlive = (response: ServerResponse, close: () => void): void => {
  const heartbeat = setInterval(() => response.write(": keepalive\n\n"), OBSERVE_HEARTBEAT_MS);
  heartbeat.unref?.();
  const done = (): void => {
    clearInterval(heartbeat);
    close();
  };
  response.on("close", done);
  response.on("error", done);
};

/**
 * The operator log feed over SSE (#374) — the delivery half of
 * `@ambient-agent/engine/logging/operator-feed.ts`, and what #382's Logs screen consumes.
 *
 * Same event vocabulary as `/api/observe`: a `snapshot` of the retained records, then one `delta`
 * per record. `?after=<seq>` resumes a reconnecting client from where it left off, and a `gap`
 * event says outright when the answer is "further back than the feed still reaches" — the ring has
 * a fixed size, so a client that was away long enough must be told, not quietly under-served.
 *
 * **A slow client is dropped, never buffered.** `response.write` returns false once the socket's
 * buffer is full, and Node will happily keep accumulating in memory from there — which is exactly
 * how a browser on a bad connection would grow the runtime's heap without bound. So when the socket
 * needs to drain, the record is skipped and counted, and the count is delivered as a `gap` once the
 * socket recovers: the client then re-reads what it missed with `?after=`. Bounded by construction,
 * and honest about it.
 */
const streamLogs = (response: ServerResponse, after: number | undefined, headersOnly = false): void => {
  const send = openEventStream(response, headersOnly);
  if (send === undefined) return;
  const feed = operatorFeed();
  const initial = feed.recent(after);
  send("snapshot", initial);
  let dropped = 0;
  const deliver = (record: OperatorFeedRecord): void => {
    if (response.writableNeedDrain) {
      dropped += 1;
      return;
    }
    if (dropped > 0) {
      const missed = dropped;
      dropped = 0;
      send("gap", { dropped: missed, resumeAfter: record.seq - missed - 1 });
    }
    send("delta", record);
  };
  // Subscribed after the snapshot is written, so no record is both in the snapshot and in a delta.
  keepAlive(response, feed.subscribe(deliver));
};

/**
 * Snapshot-plus-deltas over SSE. The client's first read is the whole state, so attaching late and
 * reattaching after a disconnect are the same operation and both recover everything; after that it
 * receives one `delta` per publication and never a replay of what the snapshot already carried.
 */
const observe = (response: ServerResponse, headersOnly = false): void => {
  const send = openEventStream(response, headersOnly);
  if (send === undefined) return;
  try {
    send("snapshot", observationSnapshot());
  } catch (cause) {
    // A value that will not serialize must cost this one client its stream, not the process. The
    // control plane exists to outlive what it diagnoses, and this handler runs synchronously inside
    // `createServer` — an escape here is an uncaught exception and the operator's surface is gone.
    process.emitWarning(cause instanceof Error ? cause : new Error(String(cause)), {
      code: "AMBIENT_OBSERVATION_THREW",
      detail: "control plane snapshot",
    });
    return void response.destroy();
  }
  // Subscribed only *after* the snapshot is written, so no publication is both in the snapshot and
  // in a delta, and none can slip between the two.
  keepAlive(
    response,
    subscribeToAllObservations((observation: Observation<unknown>) => send("delta", observation)),
  );
};

/**
 * Where the built console lives: `vp pack` writes `dist/cli/main.js`, and the console build writes
 * `dist/web/` beside it, so one relative hop finds it from either the packed bundle or the source.
 */
export const SHELL_DIRECTORY = new URL("../web/", import.meta.url);

/** Only what the console build actually emits. Anything else is served as bytes. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

/**
 * Serve one file out of the built console, with the SPA fallback that makes deep links load.
 *
 * A request is an *asset* only when it ends in an extension this build actually emits. Everything
 * else is a route inside the application and is answered with `index.html`, so `/agents` and
 * `/chats/120363000@g.us` both cold-load — the extension of that second one is `.us`, which is why
 * "has an extension" is the wrong test. An asset that misses is a real 404: falling back to the
 * shell there would serve HTML to a `<script>` tag and turn a broken build into a mystery.
 *
 * Every failure path in here answers with a status code. This handler is reached *before* the token
 * gate, so a throw would be an unauthenticated crash of a process that also hosts the runtime.
 */
const serveShell = async (directory: URL, pathname: string, method: string, response: ServerResponse) => {
  const root = resolve(fileURLToPath(directory)) + sep;
  let file: string;
  try {
    // Decode first: path normalisation does not see `%2e%2e`, so an encoded traversal would
    // otherwise survive the containment check below.
    const requested = decodeURIComponent(pathname);
    const asset = CONTENT_TYPES[extname(requested).toLowerCase()] === undefined ? "index.html" : `.${requested}`;
    // `resolve` against the root, never `new URL`: a path like `/http:/evil.com/x.js` parses as an
    // absolute URL with a non-file scheme, and `fileURLToPath` throws on it.
    file = resolve(root, asset);
  } catch {
    return respond(response, 400, { error: "bad-request" });
  }
  // The trailing separator matters: without it `dist/web-secrets` would pass as inside `dist/web`.
  if (!file.startsWith(root)) return respond(response, 404, { error: "not-found" });
  let body: Buffer;
  try {
    body = await readFile(file);
  } catch {
    return respond(response, 404, { error: "not-found" });
  }
  response.writeHead(200, {
    "content-type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    "content-length": String(body.byteLength),
    // The shell is the one unauthenticated surface; do not let a browser guess its way to a
    // different interpretation of these bytes, and do not let a stale build linger in a cache.
    "x-content-type-options": "nosniff",
    "cache-control": "no-cache",
  });
  return response.end(method === "HEAD" ? undefined : body);
};

const isApi = (path: string): boolean => path === "/api" || path.startsWith("/api/");

/** The token gate and the routes behind it. Exported for tests; `runControlPlane` binds it. */
export const createControlPlaneServer = (
  token: string,
  status: () => ControlPlaneStatus,
  shellDirectory: URL = SHELL_DIRECTORY,
): Server => {
  const expected = digest(token);
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${CONTROL_PLANE_HOST}`);
    const path = url.pathname;
    const method = request.method ?? "GET";
    // #372's amendment: the static shell is the one unauthenticated surface, because it carries no
    // installation state. Everything under /api/ keeps #364's gate, ahead of its own routing.
    if (!isApi(path)) {
      if (method !== "GET" && method !== "HEAD") return respond(response, 405, { error: "method-not-allowed" });
      // The last resort: an unauthenticated request must never be able to reject a promise nobody
      // awaits, because an unhandled rejection ends a process that is also hosting the runtime.
      return void serveShell(shellDirectory, path, method, response).catch(() => {
        if (!response.headersSent) respond(response, 500, { error: "internal" });
        response.end();
      });
    }
    const presented = bearer(request.headers.authorization);
    // The gate runs before API routing, so an unknown API path is refused exactly like a known one
    // and the token's length leaks nothing: both sides are compared as equal-width digests.
    if (presented === undefined || !timingSafeEqual(digest(presented), expected)) {
      return respond(response, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
    }
    if (path !== "/api/status" && path !== "/api/observe" && path !== "/api/logs") {
      return respond(response, 404, { error: "not-found" });
    }
    if (method !== "GET" && method !== "HEAD") return respond(response, 405, { error: "method-not-allowed" });
    // The observation channels carry live pairing material and the log feed carries message text,
    // so both endpoints sit behind the same gate as everything else — which, since `isApi` matches
    // every `/api/` path and the gate runs ahead of API routing, they already do. #372 moved the
    // static shell to the unauthenticated side; nothing under `/api/` went with it.
    // A HEAD gets the headers and nothing else; holding a subscription open for a body that Node
    // will discard would leak an observer per probe.
    const headOnly = method === "HEAD";
    if (path === "/api/observe") return observe(response, headOnly);
    if (path === "/api/logs") {
      const after = Number(url.searchParams.get("after"));
      return streamLogs(response, Number.isSafeInteger(after) && after > 0 ? after : undefined, headOnly);
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
    const token = await withManagedConfigurationSource(paths, (source) => source.secret("control-plane").token);
    return { token, persisted: true };
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
  // The identity of this run, retained before anything can subscribe (#386). A client that attaches
  // later reads it from its snapshot — that it arrives without a replayed event is the whole point,
  // and the id is minted here so it demonstrably cannot pre-date the process.
  const identity: InstanceIdentity = {
    id: randomBytes(16).toString("base64url"),
    startedAt: new Date().toISOString(),
    pid: process.pid,
  };
  // Published as well as seeded: `observed` keeps the first caller's value, and a second control
  // plane in one process (the tests do this) must not report the previous run's identity.
  observed<InstanceIdentity>(OBSERVATION_CHANNELS.instance, identity).publish(identity);
  // Was a plain mutable cell, written below and read only by the routes; it is now a channel, so a
  // boot failure is something an operator's page learns as it happens rather than by polling.
  const boot: Retained<RuntimeBoot> = observed<RuntimeBoot>(OBSERVATION_CHANNELS.runtime, { phase: "starting" });
  boot.publish(
    inspection.state === "ready" ? { phase: "starting" } : { phase: "not-configured", detail: explain(inspection) },
  );
  const server = createControlPlaneServer(token, () => ({
    instance: identity,
    dataDirectory: paths.root,
    installation: inspection.state,
    runtime: boot.snapshot().value,
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
  // A persisted token is handed over by file path and never echoed: under a service manager stdout
  // is the journal, and a token in the journal is a token in a log. The first-run token has no file
  // to point at, so it is printed — but only to a human at a terminal, for the same reason.
  output.stdout(
    persisted
      ? `Control plane bearer token: ${paths.controlPlaneCredential} (mode 0600).\n`
      : options.interactive
        ? `Control plane bearer token, unpersisted until ${paths.root} exists: ${token}\n`
        : `Control plane bearer token: minted for this process only, and not printed to a non-terminal stdout. Run ambient-agent init, or start this again from a terminal.\n`,
  );
  if (inspection.state !== "ready") {
    output.stdout(`Runtime not started: ${explain(inspection)}\n`);
    return;
  }
  try {
    await startRuntime(paths, options.logging);
    boot.publish({ phase: "running" });
  } catch (cause) {
    // Captured, never fatal. The control plane is how the operator reads this failure and fixes
    // it; exiting here would take the diagnosis surface down with the thing being diagnosed.
    const detail = cause instanceof Error ? cause.message : String(cause);
    boot.publish({ phase: "failed", detail, at: new Date().toISOString() });
    output.stderr(`ambient-agent: the runtime did not start: ${detail}\n`);
  }
};
