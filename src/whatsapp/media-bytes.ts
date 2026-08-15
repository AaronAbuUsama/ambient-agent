import { join, resolve } from "node:path";
import { fileMediaStore } from "whatsappd";

/**
 * Reads retained media bytes back out of the store.
 *
 * WhatsApp stores an inbound image before Ambient ever sees the message, and
 * the observation keeps only the `media:v1:<sha256>` ref that addresses it.
 * This is the one way back to the bytes; nothing else in the application
 * touches the store, and the bytes never enter a durable record or a prompt.
 */
export interface MediaBytes {
  read(ref: string): Promise<Buffer | undefined>;
}

export function createMediaBytes(options: {
  readonly accountId: string;
  readonly directory?: string;
}): MediaBytes {
  const mediaDirectory = join(resolve(options.directory ?? "./data"), "media");
  const store = fileMediaStore({ directory: mediaDirectory });

  return {
    async read(ref) {
      const stream = await store.open({ accountId: options.accountId, ref });
      if (!stream) return undefined;
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream) chunks.push(chunk);
      return Buffer.concat(chunks);
    },
  };
}
