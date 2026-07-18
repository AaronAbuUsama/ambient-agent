/**
 * The debounce state machine, extracted from the Coalescer's `makeChatLoop` so it
 * can be instantiated twice over two element types (#149): the raw-WhatsApp
 * coalescer (element = `CoalescerEvent`, one layer upstream) and the Scribe's
 * funnel coalescer (element = an already-composed dispatch request).
 *
 * The rule is unchanged — a throttle with a settle window: "take the next element,
 * but give up after `min(debounceWindow, timeLeftUntilCap)`" (`Queue.take` raced
 * against a virtual sleep via `timeoutOption`). The `debounceWindow` leg restarts
 * every iteration (one settle timer that resets on each new element); the `maxWait`
 * cap is measured from the burst's first element and does NOT reset, so a nonstop
 * queue still fires roughly every `maxWait`. All time routes through the Effect
 * `Clock`, so under `TestClock` the loop runs in virtual time with zero real sleeps.
 *
 * The per-layer differences are three hooks: which elements count toward the cap
 * (WhatsApp updates do not), an optional immediate-fire predicate (WhatsApp's
 * @-mention; the Scribe has none — nothing it extracts is urgent), and the flush
 * that turns a settled buffer into work.
 */
import { Clock, Duration, Effect, Option, Queue } from "effect";

export interface DebounceParams {
  /** Quiet window after which a burst is considered settled. Resets on each element. */
  readonly debounceWindow: Duration.Duration;
  /** Hard cap on how long a burst may accumulate, measured from its first element. */
  readonly maxWait: Duration.Duration;
  /** Maximum counted elements in one buffer; reaching it segments rather than evicts. */
  readonly cap: number;
}

export interface DebounceHooks<T, R> {
  /** Does this element count toward the cap? Defaults to every element. */
  readonly counts?: (element: T) => boolean;
  /** Fire the buffer immediately with this reason, skipping the wait. Defaults to never. */
  readonly fireNow?: (element: T) => R | undefined;
  /** The reasons a settle/cap/capacity flush reports. */
  readonly reasons: { readonly debounce: R; readonly maxWait: R; readonly capacity: R };
  /** Turn a settled, non-empty buffer into work. Errors are the flush's own concern. */
  readonly flush: (buffer: readonly T[], reason: R) => Effect.Effect<void>;
}

/**
 * Build the per-key debounce loop. Returns a function that, given a key's queue,
 * runs its cold → warm → fire loop forever. Fork one per key.
 */
export const debounceActor = <T, R>(params: DebounceParams, hooks: DebounceHooks<T, R>) => {
  const maxWaitMillis = Duration.toMillis(params.maxWait);
  const debounceMillis = Duration.toMillis(params.debounceWindow);
  const capacity = Math.max(1, params.cap);
  const counts = hooks.counts ?? (() => true);
  const fireNow = hooks.fireNow ?? (() => undefined);

  return (queue: Queue.Dequeue<T>): Effect.Effect<never> => {
    const fireAndReset = (buffer: readonly T[], reason: R): Effect.Effect<never> =>
      hooks.flush(buffer, reason).pipe(Effect.andThen(cold));

    // An element landed: buffer it, then flush now (immediate-fire / capacity) or keep
    // waiting. Non-counted elements (WhatsApp updates) extend the wait without counting.
    const onElement = (
      buffer: readonly T[],
      burstStart: number,
      count: number,
      element: T,
    ): Effect.Effect<never> => {
      const next = [...buffer, element];
      if (!counts(element)) return warm(next, burstStart, count);
      const now = fireNow(element);
      if (now !== undefined) return fireAndReset(next, now);
      const counted = count + 1;
      return counted >= capacity ? fireAndReset(next, hooks.reasons.capacity) : warm(next, burstStart, counted);
    };

    // Cold: nothing buffered. Block for the burst's first element, stamping `burstStart`.
    const cold: Effect.Effect<never> = Queue.take(queue).pipe(
      Effect.flatMap((element) =>
        Clock.currentTimeMillis.pipe(Effect.flatMap((now) => onElement([], now, 0, element))),
      ),
    );

    // Warm: a burst is accumulating. Wait for the next element, but give up when the
    // queue goes quiet (`debounceWindow`) OR the cap elapses (`maxWait` since
    // `burstStart`), whichever comes first — then fire and start a fresh burst.
    const warm = (buffer: readonly T[], burstStart: number, count: number): Effect.Effect<never> =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => {
          const capLeft = Math.max(0, burstStart + maxWaitMillis - now);
          const wait = Duration.min(params.debounceWindow, Duration.millis(capLeft));
          return Queue.take(queue).pipe(
            Effect.timeoutOption(wait),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  fireAndReset(buffer, capLeft <= debounceMillis ? hooks.reasons.maxWait : hooks.reasons.debounce),
                onSome: (element) => onElement(buffer, burstStart, count, element),
              }),
            ),
          );
        }),
      );

    return cold;
  };
};
