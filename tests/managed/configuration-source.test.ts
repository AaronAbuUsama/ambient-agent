import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  managedSecretPaths,
  openManagedConfigurationSource,
} from "../../packages/installation/src/configuration-source.ts";
import { atomicWriteManagedConfig } from "../../packages/installation/src/configuration.ts";
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
        expect(rendered, kind).not.toContain(secretMaterial);
        expect(rendered, kind).not.toContain("sk-live");
      }
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
  const CREDENTIAL_READERS = [
    "readManagedConfig",
    "readManagedGitHubAppCredential",
    "readManagedModelApiKey",
    "readManagedE2BApiKey",
    "readManagedBraintrustApiKey",
    "readManagedControlPlaneCredential",
    "readManagedSecretFile",
  ] as const;

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

  it("leaves every credential-file reader imported only by the seam", async () => {
    const files = (
      await Promise.all(
        [
          path.join("apps", "cli", "src"),
          path.join("apps", "runtime", "src"),
          path.join("packages", "installation", "src"),
          path.join("packages", "agents", "src"),
          path.join("packages", "engine", "src"),
        ].map(productionSources),
      )
    ).flat();
    // Guard the guard: if the scan finds nothing, the assertion below proves nothing.
    expect(files.length).toBeGreaterThan(50);

    const offenders: string[] = [];
    for (const file of files) {
      if (SEAM.includes(file)) continue;
      const contents = await readFile(path.join(process.cwd(), file), "utf8");
      for (const reader of CREDENTIAL_READERS) {
        if (new RegExp(`\\b${reader}\\b`, "u").test(contents)) offenders.push(`${file} → ${reader}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
