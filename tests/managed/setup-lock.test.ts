import { hostname, tmpdir } from "node:os";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  acquireSetupLock,
  inspectManagedData,
  releaseSetupLock,
} from "../../packages/installation/src/installation.ts";

const parents: string[] = [];
afterEach(async () => await Promise.all(parents.splice(0).map((parent) => rm(parent, { recursive: true, force: true }))));

/** A managed root that does not exist yet: first-run setup's starting state. */
const managedRoot = async () => {
  const parent = await mkdtemp(join(tmpdir(), "ambient-setup-lock-"));
  parents.push(parent);
  const root = join(parent, "managed");
  return { root, lockPath: join(parent, ".managed.setup.lock") };
};

const owner = async (lockPath: string) =>
  JSON.parse(await readFile(lockPath, "utf8")) as { pid: number; host: string; startedAt: string; attempt: string };

// A pid no OS hands out (one below the 32-bit maximum): the stand-in for an owner that is gone.
const DEAD_PID = 2_147_483_646;

const holder = async (lockPath: string, record: Record<string, unknown>) =>
  await writeFile(lockPath, JSON.stringify({ startedAt: new Date().toISOString(), attempt: "held", ...record }));

describe.skipIf(process.platform === "win32")("the setup lock", () => {
  it("records its owner: pid, host, start time, and the attempt it belongs to", async () => {
    const { root, lockPath } = await managedRoot();

    const lock = await acquireSetupLock(root);

    expect(lock.path).toBe(lockPath);
    const recorded = await owner(lockPath);
    expect(recorded).toMatchObject({ pid: process.pid, host: hostname() });
    expect(Date.parse(recorded.startedAt)).toBeLessThanOrEqual(Date.now());
    // The attempt identifier is the same token that names this attempt's staging directory,
    // so a reclaimed lock can be shown to name the second run rather than the killed one.
    expect(lock.stagingRoot).toContain(recorded.attempt);
    expect((await lstat(lockPath)).mode & 0o777).toBe(0o600);

    await releaseSetupLock(lock);
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a genuinely concurrent second setup, loudly and by name", async () => {
    // The owner is this process's parent — a real, live, different process, as in the
    // single-instance lock's test. A live owner is never reclaimed, however long it has run.
    const { root, lockPath } = await managedRoot();
    await holder(lockPath, { pid: process.ppid, host: hostname(), startedAt: "2020-01-01T00:00:00.000Z" });

    await expect(acquireSetupLock(root)).rejects.toThrow(
      new RegExp(`Setup is already in progress for ${root} \\(pid ${process.ppid} on ${hostname()}`, "u"),
    );
    // Refusal leaves the live owner's lock exactly as it was.
    expect((await owner(lockPath)).pid).toBe(process.ppid);
  });

  it("reclaims the lock an interrupted setup left behind and records the new owner", async () => {
    // A closed browser tab, a dropped connection, or a crash leaves the lock with a dead owner.
    // Reclaiming it is the ordinary next-attempt path (#371), not something a human must clear.
    const { root, lockPath } = await managedRoot();
    await holder(lockPath, { pid: DEAD_PID, host: hostname(), attempt: "the-killed-run" });

    const lock = await acquireSetupLock(root);

    const recorded = await owner(lockPath);
    expect(recorded.pid).toBe(process.pid);
    expect(recorded.attempt).not.toBe("the-killed-run");
    expect(lock.stagingRoot).toContain(recorded.attempt);
  });

  it("never reclaims a lock held by another host, whose owner it cannot check", async () => {
    // `process.kill(pid, 0)` on a pid recorded by a different machine answers about *our* pid
    // table, not theirs. Fail closed rather than reclaim on a meaningless probe.
    const { root, lockPath } = await managedRoot();
    await holder(lockPath, { pid: DEAD_PID, host: `not-${hostname()}` });

    await expect(acquireSetupLock(root)).rejects.toThrow(`on not-${hostname()}`);
  });

  it("refuses a lock that records no owner rather than assuming it is stale", async () => {
    // A pre-#369 directory lock, a truncated file, or a hand-made one: an owner we cannot name
    // is an owner we cannot prove is gone.
    const { root, lockPath } = await managedRoot();
    await mkdir(lockPath, { mode: 0o700 });

    await expect(acquireSetupLock(root)).rejects.toThrow("already in progress");

    await rm(lockPath, { recursive: true, force: true });
    await writeFile(lockPath, "not json");
    await expect(acquireSetupLock(root)).rejects.toThrow("the lock records no owner");
  });

  it("reports a live setup to doctor and stays silent about a reclaimable one", async () => {
    const { root, lockPath } = await managedRoot();
    const setupLocked = async () =>
      (await inspectManagedData({ dataDirectory: root })).diagnostics.find(({ code }) => code === "setup.locked");

    await holder(lockPath, { pid: process.ppid, host: hostname() });
    expect(await setupLocked()).toMatchObject({
      message: expect.stringContaining(`pid ${process.ppid}`),
      remediation: expect.stringContaining("Wait for it to finish"),
    });

    // The old text told the operator to remove an interrupted setup's lock by hand. That lock
    // now reclaims itself, so doctor must stop reporting it at all.
    await holder(lockPath, { pid: DEAD_PID, host: hostname() });
    expect(await setupLocked()).toBeUndefined();

    await holder(lockPath, { pid: DEAD_PID, host: `not-${hostname()}` });
    expect(await setupLocked()).toMatchObject({ remediation: expect.stringContaining("on that host") });
  });
});
