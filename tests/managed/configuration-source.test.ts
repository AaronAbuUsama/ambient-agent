import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  managedSecretPaths,
  openManagedConfigurationSource,
} from "../../packages/installation/src/configuration-source.ts";
import { atomicWriteManagedConfig } from "../../packages/installation/src/configuration.ts";
import {
  createManagedChatGptAuthentication,
  storeBackedChatGptCredentialStore,
} from "../../packages/installation/src/chatgpt-authentication.ts";
import {
  CHATGPT_PROVIDER_ID,
  createManagedChatGptCredentialStore,
  type ChatGptCredentialStore,
} from "../../packages/engine/src/model/chatgpt-authentication.ts";
import { MANAGED_SECRET_KINDS } from "../../packages/installation/src/managed-config-store.ts";
import { managedPaths, type ManagedPaths } from "../../packages/installation/src/paths.ts";
import {
  braintrustCredentialFrom,
  controlPlaneCredentialFrom,
  createManagedConfig,
  e2bCredentialFrom,
  modelApiKeyCredentialFrom,
} from "../../packages/installation/src/schema.ts";

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const appCredential = () => ({
  schemaVersion: 1,
  kind: "github-app",
  appId: "123456",
  installationId: "7891011",
  privateKey: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n",
  webhookSecret: "webhook-secret-value",
});

/** A data directory holding every credential file the eight secret kinds are seeded from. */
const fullyCredentialledRoot = async (): Promise<ManagedPaths> => {
  const root = await mkdtemp(join(tmpdir(), "aa-config-source-"));
  roots.push(root);
  const paths = managedPaths({ dataDirectory: root });
  await mkdir(paths.credentials, { recursive: true });
  await atomicWriteManagedConfig(paths.config, createManagedConfig(["120363000@g.us"], "owner/repo"));
  for (const reference of ["coder", "reviewer", "planner"] as const) {
    await atomicWriteManagedConfig(paths.githubAppCredentials[reference], appCredential());
  }
  await atomicWriteManagedConfig(paths.chatGptOAuthCredential, {
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 3_600_000,
  });
  await atomicWriteManagedConfig(paths.modelApiKeyCredential, modelApiKeyCredentialFrom("openai", "sk-model-key"));
  await atomicWriteManagedConfig(paths.e2bCredential, e2bCredentialFrom("e2b_key"));
  await atomicWriteManagedConfig(paths.braintrustCredential, braintrustCredentialFrom("bt_key"));
  await atomicWriteManagedConfig(paths.controlPlaneCredential, controlPlaneCredentialFrom("control-plane-token"));
  return paths;
};

describe("the single resolution seam (#366)", () => {
  it("seeds every secret kind from the files, so an existing installation resolves identically", async () => {
    const paths = await fullyCredentialledRoot();
    const source = await openManagedConfigurationSource(paths);
    try {
      // Tier-4 readback shape: the store shows every kind populated from the seed, names only.
      expect([...source.storedSecretKinds()].sort()).toEqual([...MANAGED_SECRET_KINDS].sort());
      expect(source.config().github.defaultRepository).toBe("owner/repo");
      expect(source.secret("github-app:planner").appId).toBe("123456");
      expect(source.secret("model-api-key")).toMatchObject({ provider: "openai", apiKey: "sk-model-key" });
      expect(source.secret("e2b").apiKey).toBe("e2b_key");
      expect(source.secret("braintrust").apiKey).toBe("bt_key");
      expect(source.secret("control-plane").token).toBe("control-plane-token");
      expect(source.secret("chatgpt-oauth").access).toBe("access-token");
    } finally {
      source.close();
    }
  });

  it("keeps every kind in this seam covered — a new kind cannot be added without a seed path", async () => {
    const paths = managedPaths({ dataDirectory: "/managed" });
    expect(Object.keys(managedSecretPaths(paths)).sort()).toEqual([...MANAGED_SECRET_KINDS].sort());
  });

  it("re-seeds from the file on refresh, so a SIGHUP reload sees the committed change", async () => {
    const paths = await fullyCredentialledRoot();
    const source = await openManagedConfigurationSource(paths);
    try {
      await atomicWriteManagedConfig(paths.config, {
        ...source.config(),
        managedChats: ["120363000@g.us", "120363001@g.us"],
      });
      expect(source.config().managedChats).toHaveLength(1);
      expect((await source.refreshConfig()).managedChats).toHaveLength(2);
    } finally {
      source.close();
    }
  });

  it("still fails loudly on a missing value, with the file reader's own error", async () => {
    const paths = await fullyCredentialledRoot();
    await rm(paths.e2bCredential);
    const source = await openManagedConfigurationSource(paths);
    try {
      // The exact ENOENT the file reader threw, so a caller that discriminates on `code` still can.
      expect(() => source.secret("e2b")).toThrow(expect.objectContaining({ code: "ENOENT" }));
      // A kind an installation does not use must not stop the rest of it booting.
      expect(source.secret("braintrust").apiKey).toBe("bt_key");
    } finally {
      source.close();
    }
  });

  it("refuses a stale stored row once its file has gone bad — the file stays authoritative (EMC)", async () => {
    const paths = await fullyCredentialledRoot();
    const seeded = await openManagedConfigurationSource(paths);
    expect(seeded.secret("braintrust").apiKey).toBe("bt_key");
    seeded.close();

    await writeFile(paths.braintrustCredential, "{ corrupted", { mode: 0o600 });
    const reopened = await openManagedConfigurationSource(paths);
    try {
      expect(() => reopened.secret("braintrust")).toThrow(/malformed/u);
    } finally {
      reopened.close();
    }
  });

  it("does not materialise a data directory that does not exist yet", async () => {
    const home = await mkdtemp(join(tmpdir(), "aa-config-source-absent-"));
    roots.push(home);
    const paths = managedPaths({ dataDirectory: join(home, "managed") });
    const source = await openManagedConfigurationSource(paths);
    try {
      expect(() => source.config()).toThrow(expect.objectContaining({ code: "ENOENT" }));
    } finally {
      source.close();
    }
    // `inspectManagedData` would classify a materialised directory `incomplete`, and
    // `ambient-agent init` would then refuse to install into it.
    await expect(readdir(join(home, "managed"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  /**
   * Carried from #365 by fix-completeness. `readPrivateJson` is the shared decoder for ALL SIX
   * credential files, and V8's `SyntaxError` quotes the opening bytes of the source it choked on —
   * so an unguarded `JSON.parse` puts a corrupted credential's own secret material in the failure
   * text of every caller that formats the error (SEC-WO).
   *
   * Non-vacuity: revert the guard in `packages/installation/src/configuration.ts` (parse inline
   * again) and this fails, printing the leaked key material from the assertion diff.
   */
  it("never puts a corrupted credential's own bytes into the failure it throws (SEC-WO)", async () => {
    const paths = await fullyCredentialledRoot();
    const secretMaterial = "sk-live-THIS-MUST-NEVER-APPEAR-IN-AN-ERROR";
    for (const kind of MANAGED_SECRET_KINDS) {
      // The bare key where the JSON envelope should be — an operator pasting the secret itself into
      // the credential file, or a truncated write. V8 quotes the OPENING bytes of what it choked on
      // ("Unexpected token 's', \"sk-live-TH\"... is not valid JSON"), so this exact corruption is
      // the one that puts secret material in the message.
      await writeFile(managedSecretPaths(paths)[kind], secretMaterial, { mode: 0o600 });
    }
    const source = await openManagedConfigurationSource(paths);
    try {
      for (const kind of MANAGED_SECRET_KINDS) {
        let thrown: unknown;
        expect(() => {
          try {
            source.secret(kind);
          } catch (cause) {
            thrown = cause;
            throw cause;
          }
        }).toThrow();
        // Message, stack and the whole serialised error — nothing of the value survives.
        const rendered = `${String(thrown)}\n${(thrown as Error).stack ?? ""}\n${JSON.stringify(
          thrown,
          Object.getOwnPropertyNames(thrown as object),
        )}`;
        // Pin the exact refusal. The `not.toContain` pair below is belt-and-braces and, on its own,
        // window-dependent: V8 quotes only ~10 characters, so a sentinel whose distinguishing prefix
        // sat past that would make them pass vacuously. This assertion is immune to the window.
        expect(String(thrown), kind).toBe("Error: The managed private JSON file is malformed.");
        expect(rendered, kind).not.toContain(secretMaterial);
        expect(rendered, kind).not.toContain("sk-live");
      }
    } finally {
      source.close();
    }
  });
});

describe("the store never outlives the file it came from (#366, EMC)", () => {
  /**
   * The regression the first round of review caught. Seeding used to leave a previous boot's row in
   * place when the file stopped reading, and the ChatGPT credential store reads `source.store`
   * directly rather than through `secret()` — so a deleted `chatgpt-oauth.json` kept resolving and
   * `doctor` reported `ready` for a credential that was gone.
   */
  it("stops resolving a credential whose file has been deleted, through every read path", async () => {
    const paths = await fullyCredentialledRoot();
    const seeded = await openManagedConfigurationSource(paths);
    expect(seeded.store.readSecret("chatgpt-oauth")).toBeDefined();
    seeded.close();

    await rm(paths.chatGptOAuthCredential);
    const reopened = await openManagedConfigurationSource(paths);
    try {
      // (a) through the seam …
      expect(() => reopened.secret("chatgpt-oauth")).toThrow(expect.objectContaining({ code: "ENOENT" }));
      // (b) … through the store the ChatGPT credential store reads directly …
      expect(reopened.store.readSecret("chatgpt-oauth")).toBeUndefined();
      // (c) … and in the tier-4 readback, which must not report a kind the seed could not populate.
      expect(reopened.storedSecretKinds()).not.toContain("chatgpt-oauth");
    } finally {
      reopened.close();
    }
  });

  it("reports a corrupted credential as unauthenticated rather than ready", async () => {
    const paths = await fullyCredentialledRoot();
    (await openManagedConfigurationSource(paths)).close();

    await writeFile(paths.chatGptOAuthCredential, "{ corrupted", { mode: 0o600 });
    const source = await openManagedConfigurationSource(paths);
    try {
      const authentication = createManagedChatGptAuthentication(source);
      // Before the fix this returned `ready` off the stale row.
      expect((await authentication.inspect()).state).not.toBe("ready");
    } finally {
      source.close();
    }
  });

  it("re-seeds a rotated credential, so `config` writing a new key is visible to the next open", async () => {
    const paths = await fullyCredentialledRoot();
    (await openManagedConfigurationSource(paths)).close();

    await atomicWriteManagedConfig(paths.braintrustCredential, braintrustCredentialFrom("bt_rotated"));
    const source = await openManagedConfigurationSource(paths);
    try {
      expect(source.secret("braintrust").apiKey).toBe("bt_rotated");
    } finally {
      source.close();
    }
  });

  it("keeps serving the last good configuration when a SIGHUP refresh finds a corrupt file", async () => {
    const paths = await fullyCredentialledRoot();
    const source = await openManagedConfigurationSource(paths);
    try {
      await writeFile(paths.config, "{ corrupted", { mode: 0o600 });
      // The reload fails loudly — `reloadAuthorizationOnSignal` logs it and carries on …
      await expect(source.refreshConfig()).rejects.toThrow();
      // … on the configuration it already had. A failed reload must not brick the running runtime.
      expect(source.config().github.defaultRepository).toBe("owner/repo");
    } finally {
      source.close();
    }
  });
});

describe("the store-backed ChatGPT credential store (#366)", () => {
  const oauthCredential = (access = "access-token") => ({
    type: "oauth" as const,
    access,
    refresh: "refresh-token",
    expires: Date.now() + 3_600_000,
  });

  /** Wired exactly as `createManagedChatGptAuthentication` wires it for a managed installation. */
  const credentialStore = (
    source: Awaited<ReturnType<typeof openManagedConfigurationSource>>,
  ): ChatGptCredentialStore =>
    storeBackedChatGptCredentialStore(
      createManagedChatGptCredentialStore({
        path: source.paths.chatGptOAuthCredential,
        managedRoot: source.paths.root,
        legacyPath: source.paths.legacyPiAuthCredential,
      }),
      source.store,
      source.paths.root,
      dirname(source.paths.chatGptOAuthCredential),
    );

  it("falls back to the file when the store holds nothing, and seeds the store on the way past", async () => {
    const paths = await fullyCredentialledRoot();
    await rm(paths.chatGptOAuthCredential);
    const source = await openManagedConfigurationSource(paths);
    try {
      // Written behind an already-open source — the fresh-install ordering.
      await atomicWriteManagedConfig(paths.chatGptOAuthCredential, oauthCredential("from-the-file"));
      expect(source.store.readSecret("chatgpt-oauth")).toBeUndefined();

      const read = await credentialStore(source).read(CHATGPT_PROVIDER_ID);

      expect(read).toMatchObject({ access: "from-the-file" });
      expect(source.store.readSecret("chatgpt-oauth")).toMatchObject({ access: "from-the-file" });
    } finally {
      source.close();
    }
  });

  it("mirrors a replaced credential into the store, so a second process reads the new one", async () => {
    const paths = await fullyCredentialledRoot();
    const source = await openManagedConfigurationSource(paths);
    try {
      await credentialStore(source).replace!(CHATGPT_PROVIDER_ID, oauthCredential("after-login"));

      expect(source.store.readSecret("chatgpt-oauth")).toMatchObject({ access: "after-login" });
      // The file stays authoritative and is written first (EMC).
      expect(JSON.parse(await readFile(paths.chatGptOAuthCredential, "utf8"))).toMatchObject({
        access: "after-login",
      });
    } finally {
      source.close();
    }
  });

  it("mirrors a refreshed credential, so the store never serves an expired access token", async () => {
    const paths = await fullyCredentialledRoot();
    const source = await openManagedConfigurationSource(paths);
    try {
      await credentialStore(source).modify(CHATGPT_PROVIDER_ID, async () => oauthCredential("after-refresh"));

      expect(source.store.readSecret("chatgpt-oauth")).toMatchObject({ access: "after-refresh" });
    } finally {
      source.close();
    }
  });

  it("forgets the store row on delete, so a revoked credential stops resolving", async () => {
    const paths = await fullyCredentialledRoot();
    const source = await openManagedConfigurationSource(paths);
    try {
      expect(source.store.readSecret("chatgpt-oauth")).toBeDefined();

      await credentialStore(source).delete!(CHATGPT_PROVIDER_ID);

      expect(source.store.readSecret("chatgpt-oauth")).toBeUndefined();
      expect(source.storedSecretKinds()).not.toContain("chatgpt-oauth");
      await expect(credentialStore(source).read(CHATGPT_PROVIDER_ID)).resolves.toBeUndefined();
    } finally {
      source.close();
    }
  });
});

/**
 * The migrate half of expand → migrate → contract (#366): the FILES still exist and still seed the
 * store, but no production reader resolves a credential file path any more. Writers still do — the
 * files stay authoritative until #367 flips that — so this is a reader-side cut, enforced by import.
 */
describe("no production reader resolves a credential file path directly (#366)", () => {
  /**
   * Derived from the module, not hand-listed: a reader added to `configuration.ts` tomorrow is
   * covered the day it appears, which a hardcoded array would not be.
   */
  const credentialReaders = async (): Promise<readonly string[]> =>
    Object.keys(await import("../../packages/installation/src/configuration.ts")).filter((name) =>
      /^read(Managed|Provisioned)/u.test(name),
    );

  /**
   * The seam itself, and the two file-side modules the seam is built out of. `migration.ts` reads a
   * *legacy* data directory's config to walk it forward — that installation predates the store and
   * has none, so it is a file reader by necessity, not a caller that skipped the seam.
   */
  const SEAM = [
    path.join("packages", "installation", "src", "configuration-source.ts"),
    path.join("packages", "installation", "src", "configuration.ts"),
    path.join("packages", "installation", "src", "migration.ts"),
  ];

  /**
   * Every path on {@link ManagedPaths} that names a credential file. A caller that skips the named
   * readers entirely — `readFile(paths.e2bCredential)` — is invisible to a reader-name scan, and is
   * the likeliest future regression, so the property names are scanned too.
   */
  const CREDENTIAL_PATH_PROPERTIES = [
    "githubAppCredentials",
    "chatGptOAuthCredential",
    "legacyPiAuthCredential",
    "legacyGithubCredential",
    "modelApiKeyCredential",
    "e2bCredential",
    "braintrustCredential",
    "controlPlaneCredential",
  ] as const;

  /**
   * Files allowed to name a credential path. Every one is a WRITER or a FILE-INTEGRITY check, not a
   * resolver of a credential's value — the distinction the migrate half of EMC turns on, since the
   * files stay authoritative until #367.
   *
   * - `paths.ts` defines them; `schema.ts`/`installation.ts`/`migration.ts` install, stage and walk
   *   installations forward; `program.ts` and `control-plane.ts` write credentials during setup and
   *   mint the first-boot token.
   * - `installation.ts` and `diagnostics.ts` also *inspect* the credential files — mode, symlink,
   *   size, is-this-valid-JSON. That is a property of the file, not of the value, and has no meaning
   *   through the store: `doctor` must still be able to say "github-coder.json is world-readable".
   * - `lifecycle.ts`, `agent-sandbox.ts` and `inspection.ts` name a path only to INTERPOLATE it into
   *   an operator-facing failure ("the E2B key at <path> is missing; run …"). Telling the owner
   *   which file to fix is the whole point of failing loudly, and every one of them resolves the
   *   value itself through the seam.
   *
   * Adding a file here is a review decision, which is the point: the list is what makes a NEW file
   * touching a credential path fail this test until someone says why it should not.
   */
  const PATH_HOLDERS = [
    ...SEAM,
    path.join("packages", "installation", "src", "paths.ts"),
    path.join("packages", "installation", "src", "installation.ts"),
    path.join("packages", "installation", "src", "diagnostics.ts"),
    path.join("packages", "installation", "src", "chatgpt-authentication.ts"),
    path.join("apps", "cli", "src", "program.ts"),
    path.join("apps", "cli", "src", "control-plane.ts"),
    path.join("apps", "cli", "src", "lifecycle.ts"),
    path.join("apps", "cli", "src", "inspection.ts"),
    path.join("packages", "installation", "src", "agent-sandbox.ts"),
  ];

  const productionSources = async (relativeDirectory: string): Promise<string[]> => {
    const entries = await readdir(path.join(process.cwd(), relativeDirectory), { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const relativePath = path.join(relativeDirectory, entry.name);
        if (entry.isDirectory()) return await productionSources(relativePath);
        return entry.isFile() && relativePath.endsWith(".ts") ? [relativePath] : [];
      }),
    );
    return nested.flat();
  };

  const PRODUCTION_ROOTS = [
    path.join("apps", "cli", "src"),
    path.join("apps", "runtime", "src"),
    path.join("packages", "installation", "src"),
    path.join("packages", "agents", "src"),
    path.join("packages", "engine", "src"),
  ];

  const allProductionSources = async (): Promise<readonly string[]> => {
    const files = (await Promise.all(PRODUCTION_ROOTS.map(productionSources))).flat();
    // Guard the guard: if the scan finds nothing, the assertions below prove nothing.
    expect(files.length).toBeGreaterThan(50);
    return files;
  };

  it("leaves every credential-file reader imported only by the seam", async () => {
    const readers = await credentialReaders();
    // The readers this node migrated all still exist to be found, or were deleted outright.
    expect(readers).toContain("readManagedConfig");
    expect(readers).toContain("readManagedSecretFile");

    const offenders: string[] = [];
    for (const file of await allProductionSources()) {
      if (SEAM.includes(file)) continue;
      const contents = await readFile(path.join(process.cwd(), file), "utf8");
      for (const reader of readers) {
        if (new RegExp(`\\b${reader}\\b`, "u").test(contents)) offenders.push(`${file} → ${reader}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The reader-name scan cannot see a caller that skips the readers and opens the path itself, so
   * the credential path properties are scanned too. This is what makes the claim "no caller reaches
   * a credential path directly" mean what it says, rather than only "no caller calls these seven
   * functions" — see {@link PATH_HOLDERS} for what is allowed to and why.
   */
  it("leaves every credential PATH named only by writers, file-integrity checks and the seam", async () => {
    const offenders: string[] = [];
    for (const file of await allProductionSources()) {
      if (PATH_HOLDERS.includes(file)) continue;
      const contents = await readFile(path.join(process.cwd(), file), "utf8");
      for (const property of CREDENTIAL_PATH_PROPERTIES) {
        if (new RegExp(`\\b${property}\\b`, "u").test(contents)) offenders.push(`${file} → paths.${property}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
