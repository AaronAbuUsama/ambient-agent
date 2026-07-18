import { describe, expect, it } from "vite-plus/test";
import * as v from "valibot";

import {
  ChatGptOAuthCredentialSchema,
  GitHubAppCredentialSchema,
  ManagedConfigSchema,
  createManagedConfig,
} from "../../packages/installation/src/schema.ts";

const APP_CREDENTIAL = {
  schemaVersion: 1,
  kind: "github-app",
  appId: "12345",
  installationId: "67890",
  privateKey: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n",
} as const;

describe("managed schemas", () => {
  it("accepts supported managed-chat JIDs and normalizes surrounding whitespace", () => {
    const config = createManagedConfig([" 120363000@g.us ", "15550000000@s.whatsapp.net"], " owner/repo ");
    const parsed = v.parse(ManagedConfigSchema, config);
    expect(parsed.managedChats).toEqual(["120363000@g.us", "15550000000@s.whatsapp.net"]);
    expect(parsed.github.defaultRepository).toBe("owner/repo");
    expect(parsed.runtime).toEqual({ port: 3000 });
  });

  it("rejects blank or malformed managed-chat identifiers", () => {
    for (const chat of ["   ", "not-a-jid", "someone@example.com"]) {
      expect(v.safeParse(ManagedConfigSchema, createManagedConfig([chat], "owner/repo")).success).toBe(false);
    }
  });

  it("requires the default repository in the case-insensitive allowlist", () => {
    const config = createManagedConfig(["120363000@g.us"], "owner/repo");
    expect(
      v.safeParse(ManagedConfigSchema, {
        ...config,
        github: { ...config.github, allowedRepositories: ["other/repository"] },
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(ManagedConfigSchema, {
        ...config,
        github: { ...config.github, defaultRepository: "OWNER/REPO" },
      }).success,
    ).toBe(true);
  });

  it("rejects a retired personal-token file and requires numeric App identifiers", () => {
    // A lingering PAT file fails the App schema and surfaces as reauthentication-required.
    expect(
      v.safeParse(GitHubAppCredentialSchema, { schemaVersion: 1, kind: "personal-token", token: "ghp_x" }).success,
    ).toBe(false);
    expect(v.safeParse(GitHubAppCredentialSchema, { ...APP_CREDENTIAL, appId: "not-numeric" }).success).toBe(false);
    expect(v.safeParse(GitHubAppCredentialSchema, { ...APP_CREDENTIAL, privateKey: "   " }).success).toBe(false);
    expect(v.safeParse(ChatGptOAuthCredentialSchema, { type: "oauth", access: "   ", refresh: "r", expires: 1 }).success).toBe(
      false,
    );
    const parsed = v.parse(GitHubAppCredentialSchema, { ...APP_CREDENTIAL, appId: " 12345 " });
    expect(parsed).toMatchObject({ kind: "github-app", appId: "12345", installationId: "67890" });
  });

  it("uses the application-owned ChatGPT credential reference", () => {
    expect(createManagedConfig(["120363000@g.us"], "owner/repo").model).toEqual({
      provider: "openai-codex",
      credential: "chatgpt-oauth",
    });
  });

  it("defaults older managed configuration to the discoverable runtime port and validates explicit ports", () => {
    const { runtime: _runtime, ...older } = createManagedConfig(["120363000@g.us"], "owner/repo");
    expect(v.parse(ManagedConfigSchema, older).runtime).toEqual({ port: 3000 });
    expect(v.safeParse(ManagedConfigSchema, { ...older, runtime: { port: 65_535 } }).success).toBe(true);
    expect(v.safeParse(ManagedConfigSchema, { ...older, runtime: { port: 65_536 } }).success).toBe(false);
  });

  it("accepts only a managed group as the dedicated smoke canary", () => {
    const config = createManagedConfig(["120363000@g.us", "15550000000@s.whatsapp.net"], "owner/repo");
    expect(
      v.safeParse(ManagedConfigSchema, { ...config, smoke: { canaryChat: "120363000@g.us" } }).success,
    ).toBe(true);
    expect(
      v.safeParse(ManagedConfigSchema, { ...config, smoke: { canaryChat: "15550000000@s.whatsapp.net" } }).success,
    ).toBe(false);
    expect(
      v.safeParse(ManagedConfigSchema, { ...config, smoke: { canaryChat: "120363999@g.us" } }).success,
    ).toBe(false);
  });
});
