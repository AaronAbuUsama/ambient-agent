import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";

import {
  createManagedConfigStore,
  MANAGED_SECRET_KINDS,
  type ManagedSecret,
  type ManagedSecretKind,
} from "../../packages/installation/src/managed-config-store.ts";
import { createManagedConfig } from "../../packages/installation/src/schema.ts";

const CHAT = "team@g.us";

const baseConfig = () => {
  const config = createManagedConfig([CHAT], "acme/widgets");
  // A non-authorization knob, to prove it is carried but never applied by a reload.
  return { ...config, runtime: { ...config.runtime, port: 3737 } };
};

describe("DB-backed managed configuration store (#179)", () => {
  it("round-trips a full validated configuration through the single row", () => {
    const store = createManagedConfigStore(":memory:");
    store.replace(baseConfig());

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

  it("re-validates against ManagedConfigSchema on write, refusing a malformed configuration", () => {
    const store = createManagedConfigStore(":memory:");
    const invalid = { ...baseConfig(), managedChats: ["not-a-jid"] };
    expect(() => store.replace(invalid as never)).toThrow();
    // The refused write left no row behind.
    expect(() => store.current()).toThrow("no configuration row");
    store.close();
  });
});

const PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----";

const githubApp: ManagedSecret<"github-app:coder"> = {
  schemaVersion: 1,
  kind: "github-app",
  appId: "12345",
  installationId: "67890",
  privateKey: PRIVATE_KEY,
};

/**
 * Every secret kind, with the value it round-trips and a value its file reader would refuse.
 * The `Record` is exhaustive by type, so adding a kind without a fixture fails to compile.
 */
const SECRET_FIXTURES: {
  [TKind in ManagedSecretKind]: { valid: ManagedSecret<TKind>; malformed: unknown };
} = {
  "github-app:coder": { valid: githubApp, malformed: { ...githubApp, appId: "not-numeric" } },
  "github-app:reviewer": { valid: githubApp, malformed: { ...githubApp, installationId: "" } },
  "github-app:planner": {
    valid: { ...githubApp, webhookSecret: "hook-secret" },
    malformed: { ...githubApp, kind: "personal-token" },
  },
  "chatgpt-oauth": {
    valid: { type: "oauth", access: "access-token", refresh: "refresh-token", expires: 1_800_000_000 },
    malformed: { type: "oauth", access: "access-token", refresh: "refresh-token", expires: "tomorrow" },
  },
  "model-api-key": {
    valid: { schemaVersion: 1, kind: "api-key", provider: "anthropic", apiKey: "sk-model" },
    malformed: { schemaVersion: 1, kind: "api-key", provider: "not-a-real-provider", apiKey: "sk-model" },
  },
  e2b: {
    valid: { schemaVersion: 1, kind: "e2b", apiKey: "e2b-key" },
    malformed: { schemaVersion: 1, kind: "e2b", apiKey: "" },
  },
  braintrust: {
    valid: { schemaVersion: 1, kind: "braintrust", apiKey: "bt-key" },
    malformed: { schemaVersion: 2, kind: "braintrust", apiKey: "bt-key" },
  },
  "control-plane": {
    valid: { schemaVersion: 1, kind: "control-plane", token: "cp-token" },
    malformed: { schemaVersion: 1, kind: "control-plane" },
  },
};

describe("the managed configuration store holds the runtime's secrets (#365)", () => {
  it("names every secret the runtime reads today", () => {
    expect([...MANAGED_SECRET_KINDS].sort()).toEqual([
      "braintrust",
      "chatgpt-oauth",
      "control-plane",
      "e2b",
      "github-app:coder",
      "github-app:planner",
      "github-app:reviewer",
      "model-api-key",
    ]);
  });

  for (const kind of MANAGED_SECRET_KINDS) {
    const fixture = SECRET_FIXTURES[kind];

    it(`round-trips the ${kind} secret at its exact shape`, () => {
      const store = createManagedConfigStore(":memory:");
      expect(store.readSecret(kind)).toBeUndefined();
      store.writeSecret(kind, fixture.valid as never);
      expect(store.readSecret(kind)).toEqual(fixture.valid);
      expect(store.storedSecretKinds()).toEqual([kind]);
      store.close();
    });

    it(`refuses a malformed ${kind} secret loudly and stores nothing`, () => {
      const store = createManagedConfigStore(":memory:");
      expect(() => store.writeSecret(kind, fixture.malformed as never)).toThrow(`The ${kind} secret is malformed.`);
      expect(store.readSecret(kind)).toBeUndefined();
      expect(store.storedSecretKinds()).toEqual([]);
      store.close();
    });
  }

  it("refuses a stored row that no longer validates rather than returning it", () => {
    const directory = mkdtempSync(join(tmpdir(), "managed-secret-"));
    const databasePath = join(directory, "managed-config.sqlite");
    try {
      const store = createManagedConfigStore(databasePath);
      store.writeSecret("e2b", SECRET_FIXTURES.e2b.valid);
      store.close();

      // Hand-edit the row the way a damaged file or a stray write would.
      const database = new DatabaseSync(databasePath);
      database.exec(`UPDATE managed_secret SET secret_json = '{"schemaVersion":1,"kind":"e2b"}' WHERE kind = 'e2b'`);
      database.close();

      const reopened = createManagedConfigStore(databasePath);
      expect(() => reopened.readSecret("e2b")).toThrow("The e2b secret is malformed.");
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("never puts secret material in a validation failure (SEC-WO)", () => {
    const nonce = `nonce-${randomUUID()}`;
    const store = createManagedConfigStore(":memory:");
    // Malformed by schemaVersion, so the refusal is about the row, not the value it carries.
    const attempt = { schemaVersion: 99, kind: "braintrust", apiKey: nonce };
    let message = "";
    try {
      store.writeSecret("braintrust", attempt as never);
    } catch (cause) {
      message = cause instanceof Error ? `${cause.message}\n${cause.stack ?? ""}` : String(cause);
    }
    expect(message).toContain("malformed");
    expect(message).not.toContain(nonce);
    store.close();
  });

  it("rejects a kind it does not know rather than storing an unvalidated blob", () => {
    const store = createManagedConfigStore(":memory:");
    expect(() => store.writeSecret("aws" as ManagedSecretKind, { apiKey: "x" } as never)).toThrow(
      "no managed secret kind",
    );
    expect(() => store.readSecret("aws" as ManagedSecretKind)).toThrow("no managed secret kind");
    store.close();
  });
});
