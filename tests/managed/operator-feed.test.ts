import { randomBytes } from "node:crypto";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { createRootLogger } from "../../packages/engine/src/logging/logging.ts";
import {
  operatorFeed,
  OPERATOR_FEED_RETAINED,
  publishToOperatorFeed,
  resetOperatorFeed,
} from "../../packages/engine/src/logging/operator-feed.ts";

beforeEach(() => {
  resetOperatorFeed();
});

/** A value that provably cannot pre-date this run, so "it was on the feed" cannot mean "it already was". */
const nonce = () => randomBytes(8).toString("hex");

describe("the operator log feed", () => {
  it("delivers what the root logger logs, without a second sink of its own", async () => {
    // The point of hanging this off the root's multistream rather than instrumenting call sites:
    // what a browser watches is the same record stream the console and the log files get.
    const minted = nonce();
    const swallowed = new PassThrough();
    swallowed.resume();
    const logger = createRootLogger({ format: "json", consoleStream: swallowed });

    logger.info({ operatorEvent: "agent.say", text: minted }, "Speaker said a WhatsApp message");

    const { records } = operatorFeed().recent();
    expect(records.at(-1)).toMatchObject({ operatorEvent: "agent.say", text: minted, seq: expect.any(Number) });
  });

  it("gives a reconnecting client exactly what it missed, and says so when it missed more than the ring holds", async () => {
    // A browser tab that was closed, or a network that dropped, comes back with its last `seq`.
    // Log records are a sequence rather than one current value, so unlike the observation seam the
    // snapshot here is a short replay — bounded, and honest about its edge.
    const feed = operatorFeed();
    const first = publishToOperatorFeed({ level: 30, msg: "one" });
    publishToOperatorFeed({ level: 30, msg: "two" });
    publishToOperatorFeed({ level: 30, msg: "three" });

    const resumed = feed.recent(first.seq);

    expect(resumed.records.map(({ msg }) => msg)).toEqual(["two", "three"]);
    expect(resumed.gap).toBe(false);

    // Now out-run the ring: the client's cursor is older than anything still retained.
    for (let index = 0; index < OPERATOR_FEED_RETAINED + 5; index += 1) {
      publishToOperatorFeed({ level: 30, msg: `flood-${index}` });
    }
    const stale = feed.recent(first.seq);

    expect(stale.records.length).toBe(OPERATOR_FEED_RETAINED);
    // Told outright, rather than quietly under-served: the client can go to the log files for the
    // rest instead of believing it has a complete narrative.
    expect(stale.gap).toBe(true);
  });

  it("stays bounded whether or not anybody is subscribed", () => {
    // "A slow or absent client never backs up the runtime" starts here: with zero subscribers the
    // feed still runs, and it still cannot grow.
    for (let index = 0; index < OPERATOR_FEED_RETAINED * 2; index += 1) {
      publishToOperatorFeed({ level: 30, msg: `record-${index}` });
    }

    const { records } = operatorFeed().recent();

    expect(records.length).toBe(OPERATOR_FEED_RETAINED);
    expect(records.at(-1)?.msg).toBe(`record-${OPERATOR_FEED_RETAINED * 2 - 1}`);
    // `seq` counts the whole stream, not the ring, so a cursor stays meaningful across eviction.
    expect(records.at(-1)?.seq).toBe(OPERATOR_FEED_RETAINED * 2);
  });

  it("isolates a subscriber that throws from the producer and from the other subscribers", () => {
    // The subscriber runs on the stack of whatever was being logged. A browser connection
    // misbehaving must not unwind the runtime work that emitted the record.
    const seen: string[] = [];
    const feed = operatorFeed();
    feed.subscribe(() => {
      throw new Error("a consumer defect");
    });
    feed.subscribe((record) => seen.push(String(record.msg)));

    expect(() => publishToOperatorFeed({ level: 30, msg: "delivered anyway" })).not.toThrow();
    expect(seen).toEqual(["delivered anyway"]);
  });

  it("stops delivering once a subscriber unsubscribes", () => {
    const seen: string[] = [];
    const unsubscribe = operatorFeed().subscribe((record) => seen.push(String(record.msg)));

    publishToOperatorFeed({ level: 30, msg: "while attached" });
    unsubscribe();
    publishToOperatorFeed({ level: 30, msg: "after hangup" });

    expect(seen).toEqual(["while attached"]);
  });
});
