/**
 * The bounded rolling buffer — a recent window, not full history.
 *
 * Pure and self-contained: age is measured against the *newest* buffered
 * message's own timestamp (not a wall clock), so eviction is deterministic and
 * needs no `Clock` read. Bounded by count (`maxBufferMessages`) and age
 * (`maxBufferAgeMillis`); the count cap is applied last so the buffer is always
 * the most-recent N regardless of arrival gaps.
 */
import { Array as Arr } from "effect";
import type { IncomingMessage } from "./events.ts";

export interface BufferBounds {
  readonly maxBufferMessages: number;
  readonly maxBufferAgeMillis: number;
}

/**
 * Append `msg`, then evict: first anything older than
 * `newest.timestamp - maxBufferAgeMillis`, then anything beyond the most-recent
 * `maxBufferMessages`. Returns a new array (input is not mutated).
 *
 * Age is anchored on the *newest* timestamp in the buffer, computed with `max`
 * rather than assuming the just-appended message is newest — WhatsApp timestamps
 * can arrive out of order (participant clock skew, delivery retries). The
 * appended message is always retained (the cutoff can never exceed its own
 * timestamp).
 */
export const appendBounded = (
  buffer: readonly IncomingMessage[],
  msg: IncomingMessage,
  bounds: BufferBounds,
): readonly IncomingMessage[] => {
  const withNew = [...buffer, msg];
  const newest = withNew.reduce((max, m) => (m.timestamp > max ? m.timestamp : max), msg.timestamp);
  const cutoff = newest - bounds.maxBufferAgeMillis;
  const recentEnough = withNew.filter((m) => m.timestamp >= cutoff);
  // Keep only the most-recent N (returns everything when N ≥ length; [] when N is 0).
  return Arr.takeRight(recentEnough, bounds.maxBufferMessages);
};
