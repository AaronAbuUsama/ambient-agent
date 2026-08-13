import { expect, test } from "vite-plus/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMandateWatcher } from "./watcher";

async function eventually(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}

test("a mandate edit wakes one debounced resync; stop drains cleanly", async () => {
  const home = await mkdtemp(join(tmpdir(), "ambient-watch-"));
  try {
    await mkdir(join(home, "chats", "tst"), { recursive: true });
    let resyncs = 0;
    const watcher = createMandateWatcher(
      home,
      async () => {
        resyncs += 1;
      },
      50,
    );
    await watcher.start();

    await writeFile(join(home, "chats", "tst", "mandate.yaml"), "chatId: 1@g.us\n");
    await writeFile(
      join(home, "chats", "tst", "mandate.yaml"),
      "chatId: 1@g.us\nmode: responding\n",
    );
    await eventually(() => resyncs >= 1);
    const afterBurst = resyncs;

    await writeFile(join(home, "chats", "tst", "mandate.yaml"), "chatId: 1@g.us\n");
    await eventually(() => resyncs >= afterBurst + 1);
    await watcher.stop();
    expect(resyncs).toBeGreaterThanOrEqual(2);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a failing resync never throws out of the watcher", async () => {
  const home = await mkdtemp(join(tmpdir(), "ambient-watch-fail-"));
  try {
    await mkdir(join(home, "chats"), { recursive: true });
    let calls = 0;
    const watcher = createMandateWatcher(
      home,
      async () => {
        calls += 1;
        throw new Error("sync exploded");
      },
      30,
    );
    await watcher.start();
    await mkdir(join(home, "chats", "new-chat"));
    await eventually(() => calls >= 1);
    await watcher.stop();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
