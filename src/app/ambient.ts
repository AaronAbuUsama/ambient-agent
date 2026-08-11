export interface Ambient {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface WhatsAppLifecycle {
  attach(): Promise<unknown>;
  dispose(): Promise<void>;
}

export interface DurableResource {
  close(): Promise<void>;
}

export interface AmbientDependencies {
  readonly database: DurableResource;
  readonly whatsapp: WhatsAppLifecycle;
}

/**
 * Own the backend process lifecycle behind one small application boundary.
 */
export function createAmbient({ database, whatsapp }: AmbientDependencies): Ambient {
  let starting: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;

  return {
    start() {
      if (stopping) return Promise.reject(new Error("Ambient has stopped"));
      starting ??= whatsapp.attach().then(() => {});
      return starting;
    },
    stop() {
      stopping ??= (async () => {
        await starting?.catch(() => {});
        try {
          await whatsapp.dispose();
        } finally {
          await database.close();
        }
      })();
      return stopping;
    },
  };
}
