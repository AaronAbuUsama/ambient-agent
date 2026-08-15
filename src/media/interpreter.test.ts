import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { expect, test } from "vite-plus/test";
import type { ModelRunner } from "../models/runtime";
import type { MediaDescription, MediaDescriptionStore } from "./contract";
import { createMediaInterpreter } from "./interpreter";

function runner(faux: ReturnType<typeof fauxProvider>, vision: boolean): ModelRunner {
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel()!;
  return {
    snapshot: { provider: "faux", model: model.id, thinking: "off", maxOutputTokens: 512 },
    model,
    thinkingLevel: "off",
    vision,
    stream: (context, options) => models.streamSimple(model, context, options),
  };
}

function memoryStore(): MediaDescriptionStore & { readonly rows: MediaDescription[] } {
  const rows: MediaDescription[] = [];
  return {
    rows,
    async find(refs) {
      return rows.filter(({ ref }) => refs.includes(ref));
    },
    async record({ model: _model, promptVersion: _promptVersion, ...description }) {
      // The real store reads back columns, not the write input: provenance is
      // retained but is not part of what a caller sees.
      if (rows.some(({ ref }) => ref === description.ref)) return;
      rows.push(description);
    },
  };
}

const bytes = { read: async () => Buffer.from("not really a jpeg") };

test("a blob is described once and never described again", async () => {
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage([fauxText("Prayer times screen showing Fajr 03:39.")]),
    fauxAssistantMessage([fauxText("a second look that must never happen")]),
  ]);
  const store = memoryStore();
  const interpreter = createMediaInterpreter({ runner: runner(faux, true), bytes, store });

  const first = await interpreter.describe([{ ref: "media:v1:aaa", mimetype: "image/jpeg" }]);
  expect(first.get("media:v1:aaa")).toEqual({
    ref: "media:v1:aaa",
    status: "described",
    description: "Prayer times screen showing Fajr 03:39.",
    mimetype: "image/jpeg",
  });

  const second = await interpreter.describe([{ ref: "media:v1:aaa", mimetype: "image/jpeg" }]);
  expect(second.get("media:v1:aaa")).toEqual(first.get("media:v1:aaa"));
  // The content hash is the key, so the model is asked exactly once.
  expect(faux.state.callCount).toBe(1);
  expect(store.rows).toHaveLength(1);
});

test("what cannot be interpreted is retained as a failure, not retried forever", async () => {
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage([fauxText("should not be called")])]);
  const store = memoryStore();
  const interpreter = createMediaInterpreter({ runner: runner(faux, true), bytes, store });

  const described = await interpreter.describe([{ ref: "media:v1:vid", mimetype: "video/mp4" }]);

  expect(described.get("media:v1:vid")).toMatchObject({ status: "failed" });
  expect(faux.state.callCount).toBe(0);
  expect(store.rows).toHaveLength(1);
});

test("a model without vision refuses to interpret rather than describing nothing", () => {
  const faux = fauxProvider();
  expect(() =>
    createMediaInterpreter({ runner: runner(faux, false), bytes, store: memoryStore() }),
  ).toThrow(/vision-capable/);
});
