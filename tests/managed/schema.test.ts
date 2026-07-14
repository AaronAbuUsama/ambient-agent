import { describe, expect, it } from "vite-plus/test";
import * as v from "valibot";

import {
  GitHubCredentialSchema,
  ManagedConfigSchema,
  PiAuthSchema,
  createManagedConfig,
} from "../../src/managed/schema.ts";

describe("managed schemas", () => {
  it("accepts supported managed-chat JIDs and normalizes surrounding whitespace", () => {
    const config = createManagedConfig([" 120363000@g.us ", "15550000000@s.whatsapp.net"], " owner/repo ");
    const parsed = v.parse(ManagedConfigSchema, config);
    expect(parsed.managedChats).toEqual(["120363000@g.us", "15550000000@s.whatsapp.net"]);
    expect(parsed.github.defaultRepository).toBe("owner/repo");
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

  it("rejects whitespace-only credentials and trims valid credential strings", () => {
    expect(
      v.safeParse(GitHubCredentialSchema, { schemaVersion: 1, kind: "personal-token", token: "   " }).success,
    ).toBe(false);
    expect(
      v.safeParse(PiAuthSchema, {
        "openai-codex": { type: "oauth", access: "   ", refresh: "refresh", expires: 1 },
      }).success,
    ).toBe(false);
    expect(v.parse(GitHubCredentialSchema, { schemaVersion: 1, kind: "personal-token", token: " token " }).token).toBe(
      "token",
    );
  });
});
