import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  createManagedConfigStore,
  writeManagedAuthorization,
} from "../../packages/installation/src/managed-config-store.ts";
import { createManagedConfig } from "../../packages/installation/src/schema.ts";

const CHAT = "team@g.us";
const ADDED_CHAT = "second@g.us";
const dirs: string[] = [];

afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const temporaryConfigPath = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "managed-config-store-"));
  dirs.push(directory);
  return join(directory, "config.json");
};

const baseConfig = () => {
  const config = createManagedConfig([CHAT], "acme/widgets");
  // A non-authorization knob, to prove it is carried but never applied by a reload.
  return { ...config, runtime: { ...config.runtime, port: 3737 } };
};

describe("DB-backed managed configuration store (#179)", () => {
  it("round-trips a full validated configuration through the single row", () => {
    const store = createManagedConfigStore(":memory:");
    const config = baseConfig();
    store.replace(config);

    const current = store.current();
    expect(current.managedChats).toEqual([CHAT]);
    expect(current.github.allowedRepositories).toEqual(["acme/widgets"]);
    // The full config — including restart-only knobs like the port — survives the round-trip.
    expect(current.runtime.port).toBe(3737);
    store.close();
  });

  it("throws rather than reloading silently when no configuration has been seeded", () => {
    const store = createManagedConfigStore(":memory:");
    expect(() => store.current()).toThrow("no configuration row");
    store.close();
  });

  it("commits a live authorization change to both config.json and the store, re-validated whole", async () => {
    const configPath = temporaryConfigPath();
    const store = createManagedConfigStore(":memory:");
    store.replace(baseConfig());

    const committed = await writeManagedAuthorization(configPath, store, {
      managedChats: [CHAT, ADDED_CHAT],
      allowedRepositories: ["acme/widgets", "acme/gadgets"],
    });

    expect(committed.managedChats).toEqual([CHAT, ADDED_CHAT]);
    // The live source reflects the change immediately (the reload path reads this).
    expect(store.current().managedChats).toEqual([CHAT, ADDED_CHAT]);
    expect(store.current().github.allowedRepositories).toEqual(["acme/widgets", "acme/gadgets"]);
    // config.json is updated durably, so the change survives a restart.
    const persisted = JSON.parse(readFileSync(configPath, "utf8"));
    expect(persisted.managedChats).toEqual([CHAT, ADDED_CHAT]);
    // The untouched restart-only knob is preserved verbatim.
    expect(persisted.runtime.port).toBe(3737);
    store.close();
  });

  it("refuses a cross-field-invalid live change and leaves both config.json and the store untouched", async () => {
    const configPath = temporaryConfigPath();
    const store = createManagedConfigStore(":memory:");
    store.replace(baseConfig());
    let wrote = false;

    // A review repository not in allowedRepositories violates a ManagedConfigSchema cross-field check.
    await expect(
      writeManagedAuthorization(
        configPath,
        store,
        { reviewRepositories: ["acme/not-allowed"] },
        async () => {
          wrote = true;
        },
      ),
    ).rejects.toThrow();

    expect(wrote).toBe(false);
    expect(store.current().github.reviewRepositories).toEqual([]);
    store.close();
  });
});
