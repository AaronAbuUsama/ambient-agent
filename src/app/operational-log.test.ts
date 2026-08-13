import { expect, test } from "vite-plus/test";
import pino from "pino";
import { Writable } from "node:stream";
import { createOperationalLog } from "./operational-log";

function capture() {
  const lines: { level: number; msg: string }[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const parsed = JSON.parse(chunk.toString()) as { level: number; msg: string };
      lines.push({ level: parsed.level, msg: parsed.msg });
      callback();
    },
  });
  return { lines, logger: pino({ level: "debug" }, sink) };
}

test("every event renders its domain line at its level", () => {
  const { lines, logger } = capture();
  const log = createOperationalLog(logger);
  log.daemonStarted("main");
  log.messageReceived("master");
  log.replySent("master");
  log.mandatesChanged("master(responding) tst(listening)");
  log.chatBroken("tst", "mode — expected listening|responding");
  log.runFailed("master", "provider unavailable");
  log.stopping("SIGINT");

  expect(lines.map(({ msg }) => msg)).toEqual([
    "ambient online (account: main)",
    "→ master: message received",
    "← master: reply sent",
    "mandates: master(responding) tst(listening)",
    "✗ chat tst: mode — expected listening|responding",
    "✗ master: run failed — provider unavailable",
    "stopping (SIGINT)",
  ]);
  // info=30, warn=40, error=50: breakage is loud, flow is info.
  expect(lines.map(({ level }) => level)).toEqual([30, 30, 30, 30, 40, 50, 30]);
});
