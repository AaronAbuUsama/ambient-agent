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
    attach(): Promise<unknown>;
    dispose(): Promise<void>;
    waitForFailure(): Promise<{ readonly error: Error }>;
  };
  readonly conversation?: {
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
}: AmbientLifecycleDependencies): Ambient {
  const exit = Promise.withResolvers<AmbientExit>();
  let starting: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let failed = false;

  return {
    start() {
      if (stopping) return Promise.reject(new Error("Ambient has stopped"));
      starting ??= (async () => {
        await whatsapp.attach();
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
          await whatsapp.dispose();
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
