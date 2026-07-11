/**
 * Coalescer tuning — feel-critical constants that will be tuned live, so they
 * are a DI service (a `Context.Tag`), never literals. Override the Layer per
 * deployment or per test; the defaults below are sane starting points.
 *
 * Decision D2 in `docs/COALESCER-DESIGN.md`.
 */
import { Context, Duration, Layer } from "effect";

export interface CoalescerConfigValues {
  /** Quiet window after which an ambient burst is considered settled. */
  readonly debounceWindow: Duration.Duration;
  /** Hard cap on the rolling buffer's message count. */
  readonly maxBufferMessages: number;
  /** Buffer age bound, in ms, measured against the newest buffered message. */
  readonly maxBufferAgeMillis: number;
  /** The bot's own JID — used to detect @-mentions and quote-replies of the bot. */
  readonly botId: string;
}

export class CoalescerConfig extends Context.Tag("CoalescerConfig")<CoalescerConfig, CoalescerConfigValues>() {}

/** Sane defaults: debounce a few seconds, buffer ~10 msgs / ~5 min. */
const defaultConfig: CoalescerConfigValues = {
  debounceWindow: Duration.seconds(3),
  maxBufferMessages: 10,
  maxBufferAgeMillis: Duration.toMillis(Duration.minutes(5)),
  botId: "bot@s.whatsapp.net",
};

/**
 * Build a config Layer, overriding any defaults you name. `configLayer({})` is
 * the plain defaults; `configLayer({ debounceWindow: Duration.seconds(5) })`
 * tweaks one knob. This is the only config surface callers need.
 */
export const configLayer = (overrides: Partial<CoalescerConfigValues> = {}): Layer.Layer<CoalescerConfig> =>
  Layer.succeed(CoalescerConfig, { ...defaultConfig, ...overrides });
