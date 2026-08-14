import { existsSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

/**
 * The policy-plane wake hint (fs-watch research): watch the chats/ and
 * agents/ trees as directories (never per-file — editors' atomic saves kill
 * file watchers), treat every event as a meaningless dirty bit, debounce,
 * then re-derive the whole truth from disk. The startup reconcile remains
 * the authority; this only makes an edit take effect without a restart.
 */
export function createMandateWatcher(
  home: string,
  resync: () => Promise<void>,
  debounceMs = 300,
): { start(): Promise<void>; stop(): Promise<void> } {
  let watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | undefined;
  let draining: Promise<void> = Promise.resolve();

  return {
    async start() {
      const dirty = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = undefined;
          draining = draining.then(async () => {
            try {
              await resync();
            } catch (error) {
              // A failed resync never kills the daemon: the next event or the
              // next startup reconcile re-derives everything from disk.
              console.error(
                `mandate resync failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          });
        }, debounceMs);
      };
      watchers = ["chats", "agents"]
        .map((tree) => join(home, tree))
        .filter((path) => existsSync(path))
        .map((path) => watch(path, { recursive: true }, dirty));
    },
    async stop() {
      for (const watcher of watchers) watcher.close();
      watchers = [];
      if (timer) clearTimeout(timer);
      timer = undefined;
      await draining;
    },
  };
}
