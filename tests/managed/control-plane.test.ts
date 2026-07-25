import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { runCli, type CliOutput, type StartRuntime } from "../../apps/cli/src/program.ts";
import { installManagedData } from "../../packages/test-support/src/managed-installation.ts";
import { managedPaths } from "../../packages/installation/src/paths.ts";
import { observed } from "../../packages/installation/src/observation.ts";

const roots: string[] = [];
const controllers: AbortController[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const temporaryHome = async () => {
  const home = await mkdtemp(join(tmpdir(), "ambient-control-plane-"));
  roots.push(home);
  return home;
};

/** A ready managed installation, the state a configured operator boots from. */
const installed = async () => {
  const dataDirectory = join(await temporaryHome(), "managed");
  await installManagedData({
    dataDirectory,
    managedChats: ["120363000@g.us"],
    defaultRepository: "owner/repo",
    authenticateChatGpt: async (paths) =>
      await writeFile(
        paths.chatGptOAuthCredential,
        JSON.stringify({ type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 }),
        { mode: 0o600 },
      ),
  });
  return dataDirectory;
};

interface RunningControlPlane {
  readonly exitCode: number;
  readonly origin: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly get: (path: string, token?: string) => Promise<Response>;
}

/**
 * Run the no-subcommand invocation the way an operator does, on an ephemeral port, and hand the
 * test the bound origin. `runCli` resolves once the control plane is bound and the runtime boot
 * has been attempted; the server keeps running until the abort signal closes it.
 */
const startControlPlane = async (
  dataDirectory: string | undefined,
  startRuntime: StartRuntime = vi.fn(async () => undefined),
  interactive = false,
): Promise<RunningControlPlane> => {
  let stdout = "";
  let stderr = "";
  const output: CliOutput = {
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
  };
  const controller = new AbortController();
  controllers.push(controller);
  const exitCode = await runCli(
    [...(dataDirectory === undefined ? [] : ["--data-dir", dataDirectory]), "--control-port", "0"],
    { output, interactive, signal: controller.signal, startRuntime },
  );
  const origin = /Control plane listening on (http:\/\/127\.0\.0\.1:\d+)/u.exec(stdout)?.[1] ?? "";
  return {
    exitCode,
    origin,
    stdout,
    stderr,
    get: async (path, token) =>
      await fetch(`${origin}${path}`, token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
  };
};

type SseReader = ReadableStreamDefaultReader<string>;

const sseReader = (response: Response): SseReader => response.body!.pipeThrough(new TextDecoderStream()).getReader();

/** Pull frames off a live SSE stream until `enough` is satisfied — it never ends on its own. */
const frames = async (reader: SseReader, enough: (seen: readonly string[]) => boolean): Promise<string[]> => {
  let buffer = "";
  for (;;) {
    const seen = buffer.split("\n\n").filter((frame) => frame.startsWith("event: "));
    if (enough(seen)) return seen;
    const { value, done } = await reader.read();
    if (done) throw new Error(`The observation stream ended after ${seen.length} events.`);
    buffer += value;
  }
};

const payload = (frame: string): Record<string, never> => JSON.parse(frame.slice(frame.indexOf("data: ") + 6));

/** Read one named SSE event, then hang up. */
const firstEvent = async (
  response: Response,
  name: string,
): Promise<Record<string, { readonly value: Record<string, unknown> }>> => {
  const reader = sseReader(response);
  try {
    const seen = await frames(reader, (candidates) => candidates.some((frame) => frame.startsWith(`event: ${name}\n`)));
    return payload(seen.find((frame) => frame.startsWith(`event: ${name}\n`))!);
  } finally {
    await reader.cancel();
  }
};

/** Let the server observe a hangup before asserting on what it did about it. */
const settle = async (): Promise<void> => await new Promise((resolve) => setTimeout(resolve, 50));

const persistedToken = async (dataDirectory: string): Promise<string> =>
  JSON.parse(await readFile(managedPaths({ dataDirectory }).controlPlaneCredential, "utf8")).token as string;

describe("the no-subcommand control plane", () => {
  it("binds its own port, stays up, and serves the booted runtime state", async () => {
    const dataDirectory = await installed();
    const startRuntime = vi.fn(async () => undefined);

    const control = await startControlPlane(dataDirectory, startRuntime);

    expect(control.exitCode).toBe(0);
    expect(control.origin).not.toBe("");
    expect(startRuntime).toHaveBeenCalledOnce();
    const response = await control.get("/api/status", await persistedToken(dataDirectory));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      dataDirectory,
      installation: "ready",
      runtime: { phase: "running" },
    });
  });

  it("keeps serving and exposes the failure when the runtime boot throws", async () => {
    // The node's whole point: a runtime that cannot come up must not take the operator's
    // surface down with it — the control plane is how the operator sees and fixes the failure.
    const dataDirectory = await installed();

    const control = await startControlPlane(dataDirectory, async () => {
      throw new Error("The managed API key at credentials/model-api-key.json is missing or unreadable.");
    });

    expect(control.exitCode).toBe(0);
    const response = await control.get("/api/status", await persistedToken(dataDirectory));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { readonly runtime: { phase: string; detail: string; at: string } };
    expect(body.runtime.phase).toBe("failed");
    expect(body.runtime.detail).toContain("missing or unreadable");
    expect(Date.parse(body.runtime.at)).not.toBeNaN();
    expect(control.stderr).toContain("missing or unreadable");
  });

  it("reports not configured rather than erroring when no configuration is present", async () => {
    const dataDirectory = join(await temporaryHome(), "absent");
    const startRuntime = vi.fn(async () => undefined);

    const control = await startControlPlane(dataDirectory, startRuntime, true);

    expect(control.exitCode).toBe(0);
    expect(startRuntime).not.toHaveBeenCalled();
    // With no data directory there is no file to point at, so the one-off token is printed instead.
    const token = /Control plane bearer token[^:]*: (\S+)/u.exec(control.stdout)?.[1] ?? "";
    const response = await control.get("/api/status", token);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      installation: "absent",
      runtime: { phase: "not-configured" },
    });
    // An unconfigured control plane must not mint the data directory: `inspectManagedData` would
    // then classify it incomplete and `ambient-agent init` would refuse to install into it.
    await expect(readdir(dataDirectory)).rejects.toThrow(/ENOENT/u);
  });

  it("never prints the first-run token to a non-terminal stdout", async () => {
    // Under a service manager stdout is the journal, so printing there is printing to a log. A
    // token that has no file to be handed over by is only ever shown to a human at a terminal.
    const dataDirectory = join(await temporaryHome(), "absent");

    const control = await startControlPlane(dataDirectory);

    expect(control.stdout).toContain("Control plane listening on http://127.0.0.1:");
    expect(control.stdout).toContain("not printed to a non-terminal stdout");
    expect(control.stdout).not.toMatch(/unpersisted until .* exists: \S/u);
    expect((await control.get("/api/status")).status).toBe(401);
  });

  it("rejects every route on a missing, malformed, or wrong bearer token", async () => {
    const dataDirectory = await installed();
    const control = await startControlPlane(dataDirectory);
    const token = await persistedToken(dataDirectory);

    for (const path of ["/api/status", "/api/unknown", "/"]) {
      expect((await control.get(path)).status, `${path} without a token`).toBe(401);
      expect((await control.get(path, "wrong-token")).status, `${path} with a wrong token`).toBe(401);
      expect((await control.get(path, `${token}x`)).status, `${path} with a near-miss token`).toBe(401);
    }
    expect((await fetch(`${control.origin}/api/status`, { headers: { authorization: token } })).status).toBe(401);
    // Authorized, but there is nothing there: routing happens behind the gate, never in front of it.
    expect((await control.get("/api/unknown", token)).status).toBe(404);
  });

  it("generates the token once, persists it, and keeps it out of stdout and the log files", async () => {
    const dataDirectory = await installed();

    const first = await startControlPlane(dataDirectory);
    const token = await persistedToken(dataDirectory);
    controllers.splice(0).forEach((controller) => controller.abort());
    const second = await startControlPlane(dataDirectory);

    expect(await persistedToken(dataDirectory)).toBe(token);
    expect((await second.get("/api/status", token)).status).toBe(200);
    for (const stream of [first.stdout, first.stderr, second.stdout, second.stderr]) {
      expect(stream).not.toContain(token);
    }
    const logs = managedPaths({ dataDirectory }).logs;
    const files = await readdir(logs).catch(() => []);
    for (const file of files) {
      expect(await readFile(join(logs, file), "utf8"), file).not.toContain(token);
    }
  });

  it("opens the observation stream with a snapshot of state published before anyone attached", async () => {
    // The nonce is minted during boot, published to the seam before the port is even bound, and
    // read back by a client that connects afterwards — so what the client received cannot be a
    // replayed event, and cannot have pre-existed the run.
    const dataDirectory = await installed();
    const control = await startControlPlane(dataDirectory);
    const token = await persistedToken(dataDirectory);
    const identity = (await (await control.get("/api/status", token)).json()) as {
      readonly instance: { readonly id: string };
    };

    const stream = await control.get("/api/observe", token);

    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toBe("text/event-stream");
    const snapshot = await firstEvent(stream, "snapshot");
    expect(snapshot.instance?.value).toMatchObject({ id: identity.instance.id, pid: process.pid });
    expect(snapshot.runtime?.value).toEqual({ phase: "running" });
    expect(identity.instance.id).not.toBe("");
  });

  it("recovers full state for a client that reconnects, and keeps producing while none is attached", async () => {
    const dataDirectory = await installed();
    const control = await startControlPlane(dataDirectory);
    const token = await persistedToken(dataDirectory);

    const before = await firstEvent(await control.get("/api/observe", token), "snapshot");
    // `firstEvent` already hung up, exactly as closing a browser tab does.
    // The producer carried on regardless: this publication lands with zero subscribers attached.
    const channel = observed<{ readonly beat: string }>("test-liveness", { beat: "" });
    const beat = `beat-${Date.now()}`;
    channel.publish({ beat });

    const after = await firstEvent(await control.get("/api/observe", token), "snapshot");

    expect(before["test-liveness"]).toBeUndefined();
    expect(after["test-liveness"]?.value).toEqual({ beat });
    expect(after.instance?.value).toEqual(before.instance?.value);
  });

  it("sends a delta for every publication after the snapshot, including on a channel created later", async () => {
    const dataDirectory = await installed();
    const control = await startControlPlane(dataDirectory);
    const token = await persistedToken(dataDirectory);
    const existing = observed<string>("test-existing", "before");

    // The handler writes the snapshot and takes its subscription synchronously, before `fetch`
    // resolves — so anything published from here on is a delta, never part of the snapshot.
    const reader = sseReader(await control.get("/api/observe", token));
    existing.publish("after");
    // The runtime boots after the control plane has accepted clients, so its channels are always
    // late. A client must learn about them without reconnecting.
    observed<string>("test-appeared-later", "first value");

    const seen = await frames(reader, (candidates) => candidates.length >= 3);
    await reader.cancel();

    const deltas = seen.filter((frame) => frame.startsWith("event: delta")).map(payload);
    expect(deltas).toMatchObject([
      { channel: "test-existing", value: "after", revision: 1 },
      { channel: "test-appeared-later", value: "first value", revision: 0 },
    ]);
  });

  it("releases its subscription when the client hangs up", async () => {
    // Without this the process leaks an observer per browser tab, and every publication keeps
    // serializing itself into a response nobody is reading.
    const dataDirectory = await installed();
    const control = await startControlPlane(dataDirectory);
    const token = await persistedToken(dataDirectory);
    // `notify` returns early at zero observers, so a projection that never runs after the hangup is
    // proof that the subscription is gone.
    let projections = 0;
    const channel = observed<string>("test-leak", "value");
    channel.refreshWith((value) => {
      projections += 1;
      return value;
    });

    await firstEvent(await control.get("/api/observe", token), "snapshot");
    await settle();
    const afterHangup = projections;
    channel.publish("published to nobody");

    expect(projections).toBe(afterHangup);
    expect(channel.snapshot().value).toBe("published to nobody");
  });

  it("refuses the observation stream without a token, like every other path", async () => {
    const dataDirectory = await installed();
    const control = await startControlPlane(dataDirectory);

    expect((await control.get("/api/observe")).status).toBe(401);
    expect((await control.get("/api/observe", "wrong-token")).status).toBe(401);
  });

  it("refuses loudly when another live process already holds the data directory", async () => {
    // #311: two processes on one data directory share the SQLite pair and the WhatsApp session.
    // The owner here is this process's parent — a real, live, different pid.
    const dataDirectory = await installed();
    await writeFile(join(dataDirectory, "runtime.lock"), `${process.ppid}\n`);

    const control = await startControlPlane(dataDirectory);

    expect(control.exitCode).toBe(1);
    expect(control.stderr).toContain(`Another ambient-agent runtime (pid ${process.ppid}) is already using`);
    expect(control.origin).toBe("");
  });
});
