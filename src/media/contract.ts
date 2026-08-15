/**
 * What one piece of retained media shows.
 *
 * A description is evidence, not a prompt detail: it is written once per unique
 * blob, retained, and read by every role that later needs to know what the
 * picture was. `failed` is retained for the same reason — a blob that cannot be
 * read must not be retried on every recall.
 */
export type MediaDescription =
  | {
      readonly ref: string;
      readonly status: "described";
      readonly description: string;
      readonly mimetype?: string;
    }
  | {
      readonly ref: string;
      readonly status: "failed";
      readonly failureReason: string;
      readonly mimetype?: string;
    };

/** Retention for descriptions, keyed by the media store's content hash. */
export interface MediaDescriptionStore {
  /** Descriptions already written for these refs; missing refs are absent. */
  find(refs: readonly string[]): Promise<readonly MediaDescription[]>;
  /** First writer wins: describing the same blob twice must not fork it. */
  record(
    input: MediaDescription & {
      readonly model: string;
      readonly promptVersion: string;
    },
  ): Promise<void>;
}

/**
 * Turns media refs into descriptions, doing the work at most once per blob.
 *
 * The interpreter owns the vision call, the retention, and the decision not to
 * look at kinds it cannot interpret. Callers pass refs and receive text.
 */
export interface MediaInterpreter {
  describe(
    media: readonly {
      readonly ref: string;
      readonly mimetype?: string | undefined;
      readonly caption?: string | undefined;
    }[],
  ): Promise<ReadonlyMap<string, MediaDescription>>;
}
