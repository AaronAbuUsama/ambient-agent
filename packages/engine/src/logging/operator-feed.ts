/**
 * The operator log feed (#374): the same records the console and the rotating files already get,
 * made subscribable from inside the process so a browser can watch them live.
 *
 * **The nest it closes.** The root logger was a Pino instance over a `multistream` with exactly two
 * sinks, built once. Nothing exposed the record stream to another module, so "show me what the
 * coworker is doing right now" meant `ssh` and `tail`. The whole feature is a third sink: a
 * `Writable` that parses each NDJSON line and fans it out.
 *
 * **The shape, deliberately the same as the observation seam's (#386): snapshot plus deltas.**
 * {@link OperatorFeed.recent} is the snapshot — a bounded ring of the most recent records — and
 * {@link OperatorFeed.subscribe} is the deltas. A client reads the ring on connect and receives
 * records thereafter, and on reconnect it passes back the last `seq` it saw so the server can
 * hand it exactly what it missed. Log records are an append-only sequence rather than one current
 * value, which is the one place this differs from the observation seam: here the snapshot *is* a
 * short replay, because there is no single value that summarises a log.
 *
 * **What it promises**
 *
 * 1. **A slow or absent client never blocks the producer.** `write` is synchronous, appends to a
 *    ring, and iterates a possibly empty subscriber set. Nothing is awaited, nothing queues, and a
 *    throwing subscriber is isolated. The delivery side is where a slow client would otherwise do
 *    damage, and it drops rather than buffers — see {@link OperatorFeed.subscribe}'s contract and
 *    the control plane's `/api/logs`, which skips a record when the socket needs to drain and
 *    reports the gap instead of growing without bound.
 * 2. **Memory is bounded, always.** {@link OPERATOR_FEED_RETAINED} records, oldest evicted first,
 *    whether anybody is subscribed or not.
 * 3. **Reconnect is not a reset.** `seq` is monotonic for the life of the process, so a client that
 *    disconnects and comes back asks for `after: <last seq>` and learns both what it missed and —
 *    if the ring has since rotated past it — that it missed more than the ring can still say.
 *
 * Records arrive here *after* the root's redaction, so credential-shaped fields are already
 * censored; this sink adds no new exposure beyond the file sink that already exists. It is still a
 * privileged surface — it carries message text — and the control plane serves it behind the same
 * bearer gate as everything else.
 */
import { Writable } from "node:stream";

import type { OperatorLogRecord } from "./operator-reporter.ts";

/**
 * How much of the log a reconnecting client can still be given. Small on purpose: this is a live
 * feed, not the archive — the rotating files under `logs/` are the archive, and a client that
 * needs more than this has out-run the feed and should be told so rather than quietly under-served.
 */
// ponytail: one fixed ring for every subscriber, no per-subscriber cursor buffering. Widen only if
// an operator surface actually needs deeper backfill than the log files already give it.
export const OPERATOR_FEED_RETAINED = 500;

/** A feed record: the logged record, plus its position in this process's stream. */
export interface OperatorFeedRecord extends OperatorLogRecord {
  readonly seq: number;
}

export interface OperatorFeed {
  /**
   * The retained records, oldest first — everything after `after`, or the whole ring when omitted.
   * `gap` is true when `after` is older than the ring still holds, i.e. records were evicted before
   * this client could be given them.
   */
  readonly recent: (after?: number) => { readonly records: readonly OperatorFeedRecord[]; readonly gap: boolean };
  /**
   * Records from now on. The observer is called synchronously on the *producer's* stack, so it must
   * not block and must not throw — a throw is caught and isolated, but a slow observer is the one
   * thing this seam cannot defend against for you. Returns unsubscribe.
   */
  readonly subscribe: (observer: (record: OperatorFeedRecord) => void) => () => void;
}

interface FeedState {
  readonly records: OperatorFeedRecord[];
  readonly subscribers: Set<(record: OperatorFeedRecord) => void>;
  seq: number;
}

/**
 * On `globalThis` for the same reason the logging root and the observation registry are: the CLI
 * and the separately bundled runtime are one process with two module graphs, and a module-level
 * variable here would mean the runtime writes to a feed the control plane cannot read.
 */
const FEED = Symbol.for("ambient-agent.operator-feed");
const feedGlobal = globalThis as typeof globalThis & { [FEED]?: FeedState };
const state = (): FeedState => (feedGlobal[FEED] ??= { records: [], subscribers: new Set(), seq: 0 });

/**
 * A subscriber runs on the producer's stack — inside whatever was being logged. It must never
 * unwind that producer. Reported through `process.emitWarning` rather than the logger for the
 * obvious reason: logging from inside the log sink is how you get an infinite loop.
 */
const isolate = (act: () => void): void => {
  try {
    act();
  } catch (cause) {
    process.emitWarning(cause instanceof Error ? cause : new Error(String(cause)), {
      code: "AMBIENT_OPERATOR_FEED_THREW",
      detail: "operator feed subscriber",
    });
  }
};

/** Admit one already-parsed record. Exported for tests and for any non-Pino producer. */
export const publishToOperatorFeed = (record: OperatorLogRecord): OperatorFeedRecord => {
  const feed = state();
  feed.seq += 1;
  const published: OperatorFeedRecord = { ...record, seq: feed.seq };
  feed.records.push(published);
  if (feed.records.length > OPERATOR_FEED_RETAINED) feed.records.splice(0, feed.records.length - OPERATOR_FEED_RETAINED);
  for (const subscriber of [...feed.subscribers]) isolate(() => subscriber(published));
  return published;
};

export const operatorFeed = (): OperatorFeed => ({
  recent: (after) => {
    const { records, seq } = state();
    if (after === undefined) return { records: [...records], gap: false };
    const first = records[0]?.seq;
    return {
      records: records.filter((record) => record.seq > after),
      gap:
        // The client asked to resume from a point the ring no longer reaches back to.
        (first !== undefined && first > after + 1) ||
        // Or from a point this process has not reached at all — which is what a cursor from a
        // *previous* process looks like, because `seq` restarts at 0 on every boot. Without this a
        // tab reconnecting across a restart is handed an empty snapshot and an explicit "you missed
        // nothing", then sits blank against a live, noisy runtime. That is #370's blank pairing
        // page in a new costume, and it is the likeliest reconnect there is.
        after > seq,
    };
  },
  subscribe: (observer) => {
    const { subscribers } = state();
    subscribers.add(observer);
    return () => subscribers.delete(observer);
  },
});

/**
 * The `multistream` sink. Pino hands it NDJSON, possibly split mid-line across writes, so the line
 * reassembly matches `createOperatorConsoleSink` — same problem, same solution.
 */
export const operatorFeedSink = (): Writable => {
  let buffered = "";
  const admit = (line: string): void => {
    if (line.length === 0) return;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      // Not a JSON line. The feed's contract is structured records; a malformed one is dropped
      // rather than forwarded as a shape no consumer can read. Only the parse is guarded: wrapping
      // the publish too would silently reinterpret a ring-bookkeeping failure as "bad input" and
      // the feed would go quiet with nothing anywhere saying why.
      return;
    }
    // `JSON.parse` happily returns `null`, `3`, `"x"`. Spreading one of those into a record hands
    // subscribers a shape no renderer can read, so require an object.
    if (typeof record !== "object" || record === null || Array.isArray(record)) return;
    publishToOperatorFeed(record as OperatorLogRecord);
  };
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      buffered += chunk.toString();
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) admit(line);
      // Called synchronously and unconditionally: this sink never applies backpressure to the
      // logger, because the logger is the runtime doing its actual work.
      callback();
    },
    final(callback) {
      admit(buffered);
      callback();
    },
  });
};

/** Tests only: the feed is process-global, so a test that publishes must be able to start clean. */
export const resetOperatorFeed = (): void => {
  delete feedGlobal[FEED];
};
