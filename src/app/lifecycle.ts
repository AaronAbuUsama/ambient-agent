export type AmbientExit =
  | { readonly kind: "stopped" }
  | { readonly kind: "failed"; readonly error: Error };

export interface Ambient {
  start(): Promise<void>;
  wait(): Promise<AmbientExit>;
  stop(): Promise<void>;
}

export interface AmbientLifecycleDependencies {
  readonly database: {
    close(): Promise<void>;
  };
  readonly whatsapp: {
    start(): Promise<unknown>;
    stop(): Promise<void>;
    waitForFailure(): Promise<{ readonly error: Error }>;
  };
  readonly conversation?: {
    start(): Promise<void>;
    stop(): Promise<void>;
  };
  /** Evaluation observes durable evidence; it does not depend on channel health. */
  readonly evaluations?: {
    start(): Promise<void>;
    stop(): Promise<void>;
  };
  /** The policy-plane wake hint: mandate edits take effect without a restart. */
  readonly policyWatcher?: {
    start(): Promise<void>;
    stop(): Promise<void>;
  };
  /** Memory digests durable jobs; it does not depend on channel health. */
  readonly memoryService?: {
    start(): Promise<void>;
    stop(): Promise<void>;
  };
  /** Workers drain durable assignments; they do not depend on channel health. */
  readonly worker?: {
    start(): Promise<void>;
    stop(): Promise<void>;
  };
}

function asError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string") return new Error(error);
  return new Error("Ambient cleanup failed", { cause: error });
}

/** Own idempotent process lifecycle and surface unexpected channel failure. */
export function createAmbientLifecycle({
  database,
  whatsapp,
  conversation,
  evaluations,
  policyWatcher,
  memoryService,
  worker,
}: AmbientLifecycleDependencies): Ambient {
  const exit = Promise.withResolvers<AmbientExit>();
  let starting: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let failed = false;

  return {
    start() {
      if (stopping) return Promise.reject(new Error("Ambient has stopped"));
      starting ??= (async () => {
        await policyWatcher?.start();
        await evaluations?.start();
        await memoryService?.start();
        await worker?.start();
        await whatsapp.start();
        void whatsapp.waitForFailure().then(({ error }) => {
          if (stopping) return;
          failed = true;
          exit.resolve({ kind: "failed", error });
        });
        // A channel may detach in the same turn that attach resolves. Let an
        // already-settled failure update the lifecycle before Conversation starts.
        await Promise.resolve();
        if (stopping || failed) return;
        await conversation?.start();
      })();
      return starting;
    },
    wait() {
      return exit.promise;
    },
    stop() {
      stopping ??= (async () => {
        await starting?.catch(() => {});
        let cleanupError: unknown;
        try {
          await conversation?.stop();
        } catch (error) {
          cleanupError = error;
        }
        try {
          await worker?.stop();
        } catch (error) {
          cleanupError ??= error;
        }
        try {
          await memoryService?.stop();
        } catch (error) {
          cleanupError ??= error;
        }
        try {
          await evaluations?.stop();
        } catch (error) {
          cleanupError ??= error;
        }
        try {
          await policyWatcher?.stop();
        } catch (error) {
          cleanupError ??= error;
        }
        try {
          await whatsapp.stop();
        } catch (error) {
          cleanupError ??= error;
        }
        try {
          await database.close();
        } catch (error) {
          cleanupError ??= error;
        }
        if (cleanupError !== undefined) {
          const error = asError(cleanupError);
          exit.resolve({ kind: "failed", error });
          throw error;
        } else {
          exit.resolve({ kind: "stopped" });
        }
      })();
      return stopping;
    },
  };
}
