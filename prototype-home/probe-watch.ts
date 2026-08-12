// PROTOTYPE — throwaway. Walking-skeleton probe: fs.watch vs editor atomic
// saves. Watches the chats/ DIRECTORY (research: survives atomic saves) and
// one FILE directly (research: silently dies on the inode swap).
// Run: npx tsx prototype-home/probe-watch.ts
// Then edit prototype-home/home/chats/tst/mandate.yaml in your editor and
// save a few times. Ctrl+C to stop.
import { watch } from "node:fs";
import path from "node:path";

const homeDir = path.join(import.meta.dirname, "home");
const chatsDir = path.join(homeDir, "chats");
const mandateFile = path.join(chatsDir, "tst/mandate.yaml");

let pending: string[] = [];
let timer: NodeJS.Timeout | undefined;

function hint(source: string, eventType: string, filename: string | null) {
  const stamp = new Date().toISOString().slice(11, 23);
  console.log(`  ${stamp} [${source}] eventType=${eventType} filename=${filename ?? "(null)"}`);
  pending.push(`${source}:${filename ?? "?"}`);
  clearTimeout(timer);
  // 200ms debounce per the fs-watch research: coalesce bursts into one wake hint.
  timer = setTimeout(() => {
    console.log(
      `  >>> WAKE HINT (dirty bit) after ${pending.length} raw events — rescan would run now\n`,
    );
    pending = [];
  }, 200);
}

console.log(`Watching DIRECTORY (recursive): ${path.relative(process.cwd(), chatsDir)}`);
watch(chatsDir, { recursive: true }, (eventType, filename) =>
  hint("dir-watch ", eventType, filename),
);

console.log(`Watching FILE directly:          ${path.relative(process.cwd(), mandateFile)}`);
console.log(`  (research says this one silently dies on an editor's atomic save)\n`);
watch(mandateFile, (eventType, filename) => hint("FILE-watch", eventType, filename));

console.log(`Now edit + save chats/tst/mandate.yaml in your editor. Ctrl+C to stop.`);
console.log(
  `Expected: dir-watch keeps firing forever; FILE-watch reports one rename, then silence.\n`,
);
