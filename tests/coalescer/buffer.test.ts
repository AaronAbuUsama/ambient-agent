/**
 * Unit tests for the rolling buffer's two bounds — count and age. The coalescer
 * integration tests exercise the count cap; age eviction is pure and easiest to
 * pin down here directly.
 */
import { describe, expect, it } from "vitest";
import { appendBounded, type BufferBounds } from "../../src/coalescer/buffer.ts";
import type { IncomingMessage } from "../../src/coalescer/events.ts";

const BOUNDS: BufferBounds = { maxBufferMessages: 10, maxBufferAgeMillis: 5 * 60_000 };

const msg = (text: string, timestamp: number): IncomingMessage => ({
  id: text,
  chatId: "c@g.us",
  from: "u@s.whatsapp.net",
  text,
  timestamp,
  isGroup: true,
  fromMe: false,
  live: true,
  mentions: [],
});

const build = (msgs: readonly IncomingMessage[], bounds: BufferBounds): readonly IncomingMessage[] =>
  msgs.reduce<readonly IncomingMessage[]>((buf, m) => appendBounded(buf, m, bounds), []);

describe("appendBounded", () => {
  it("keeps recent messages under both bounds untouched", () => {
    const out = build([msg("a", 1_000), msg("b", 2_000), msg("c", 3_000)], BOUNDS);
    expect(out.map((m) => m.text)).toEqual(["a", "b", "c"]);
  });

  it("caps to the most-recent N by count", () => {
    const bounds: BufferBounds = { maxBufferMessages: 3, maxBufferAgeMillis: 5 * 60_000 };
    const out = build([1, 2, 3, 4, 5].map((n) => msg(`m${n}`, n * 1_000)), bounds);
    expect(out.map((m) => m.text)).toEqual(["m3", "m4", "m5"]);
  });

  it("evicts messages older than maxBufferAge relative to the newest message", () => {
    const bounds: BufferBounds = { maxBufferMessages: 10, maxBufferAgeMillis: 60_000 };
    // t=0 and t=30s are within 60s of the newest (t=90s); t=90s is the anchor.
    // t=0 is 90s old → evicted; t=30s is 60s old → exactly at the boundary → kept.
    const out = build([msg("old", 0), msg("mid", 30_000), msg("new", 90_000)], bounds);
    expect(out.map((m) => m.text)).toEqual(["mid", "new"]);
  });

  it("applies age eviction before the count cap (never returns a stale message)", () => {
    const bounds: BufferBounds = { maxBufferMessages: 5, maxBufferAgeMillis: 10_000 };
    // A long-idle first message, then a fresh burst well after the age window.
    const out = build(
      [msg("stale", 0), msg("x", 100_000), msg("y", 101_000), msg("z", 102_000)],
      bounds,
    );
    expect(out.map((m) => m.text)).toEqual(["x", "y", "z"]);
  });
});
