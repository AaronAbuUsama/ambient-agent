import { assistantText } from "../models/assistant-text";
import type { ModelRunner } from "../models/runtime";
import type { MediaBytes } from "../whatsapp/media-bytes";
import type { MediaDescription, MediaDescriptionStore, MediaInterpreter } from "./contract";

export const mediaPromptVersion = "media-v1";

const systemPrompt = `You describe one piece of media shared in a work chat, for a reader who cannot see it.

Report what is actually there. Quote every time, number, label, and error string verbatim — a
screenshot of a bug is usually evidence about exactly those. Note the platform when the interface
makes it obvious. Do not diagnose, do not speculate about intent, and never state something the
image does not show. Answer in at most 120 words of plain prose.`;

/** Kinds a vision model can actually interpret. Video needs frames, not a still. */
const interpretableMimetypes = /^image\//;

export function createMediaInterpreter(options: {
  readonly runner: ModelRunner;
  readonly bytes: MediaBytes;
  readonly store: MediaDescriptionStore;
}): MediaInterpreter {
  const { runner, bytes, store } = options;
  if (!runner.vision) {
    // Fail at composition, not at the call: the harness silently replaces
    // images with a placeholder, so a blind model would produce confident
    // descriptions of nothing.
    throw new Error(
      `media interpretation needs a vision-capable model; ` +
        `"${runner.snapshot.provider}/${runner.snapshot.model}" does not declare one`,
    );
  }

  const describeOne = async (media: {
    readonly ref: string;
    readonly mimetype?: string | undefined;
    readonly caption?: string | undefined;
  }): Promise<MediaDescription> => {
    const mimetype = media.mimetype;
    if (mimetype === undefined || !interpretableMimetypes.test(mimetype)) {
      return {
        ref: media.ref,
        status: "failed",
        failureReason: `not an interpretable image (${mimetype ?? "unknown type"})`,
        ...(mimetype === undefined ? {} : { mimetype }),
      };
    }

    const blob = await bytes.read(media.ref);
    if (!blob) {
      return {
        ref: media.ref,
        status: "failed",
        failureReason: "bytes are not in the store",
        mimetype,
      };
    }

    const message = await runner
      .stream({
        systemPrompt,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: media.caption
                  ? `The sender captioned this: "${media.caption}"`
                  : "The sender added no caption.",
              },
              { type: "image", data: blob.toString("base64"), mimeType: mimetype },
            ],
            timestamp: Date.now(),
          },
        ],
      })
      .result();

    if (message.stopReason === "error" || message.stopReason === "aborted") {
      return {
        ref: media.ref,
        status: "failed",
        failureReason: message.errorMessage ?? `model ${message.stopReason}`,
        mimetype,
      };
    }

    const description = assistantText(message).trim();
    if (!description) {
      return {
        ref: media.ref,
        status: "failed",
        failureReason: "model returned no text",
        mimetype,
      };
    }
    return { ref: media.ref, status: "described", description, mimetype };
  };

  return {
    async describe(media) {
      const wanted = [...new Map(media.map((item) => [item.ref, item])).values()];
      if (wanted.length === 0) return new Map();

      const known = await store.find(wanted.map(({ ref }) => ref));
      const byRef = new Map(known.map((description) => [description.ref, description]));

      const missing = wanted.filter(({ ref }) => !byRef.has(ref));
      for (const item of missing) {
        const described = await describeOne(item);
        await store.record({
          ...described,
          model: `${runner.snapshot.provider}/${runner.snapshot.model}`,
          promptVersion: mediaPromptVersion,
        });
        byRef.set(described.ref, described);
      }
      return byRef;
    },
  };
}
