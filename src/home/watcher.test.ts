import { expect, test } from "vite-plus/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMandateWatcher } from "./watcher";

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

    // The FSEvents stream may not be live immediately after start: keep
    // nudging until an event lands rather than racing a single write.
    const nudgeUntil = async (target: number) => {
      const deadline = Date.now() + 8_000;
      while (resyncs < target) {
        if (Date.now() > deadline) throw new Error("watcher never fired");
        await writeFile(join(home, "chats", "tst", "mandate.yaml"), `chatId: ${Date.now()}\n`);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      }
    };
    await nudgeUntil(1);
    await nudgeUntil(2);
    await watcher.stop();
    expect(resyncs).toBeGreaterThanOrEqual(2);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 15_000);

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
    await mkdir(join(home, "chats", "new-chat"), { recursive: true });
    // The FSEvents stream may not be live immediately after start: keep
    // nudging until an event lands rather than racing a single write.
    const deadline = Date.now() + 8_000;
    while (calls < 1) {
      if (Date.now() > deadline) throw new Error("watcher never fired");
      await writeFile(join(home, "chats", "new-chat", "mandate.yaml"), `chatId: ${Date.now()}\n`);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    await watcher.stop();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 15_000);
