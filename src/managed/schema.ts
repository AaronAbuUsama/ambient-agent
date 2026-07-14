import * as v from "valibot";

export const GITHUB_CREDENTIAL_REFERENCE = "github";
export const PI_AUTH_CREDENTIAL_REFERENCE = "pi-auth";

const Repository = v.pipe(v.string(), v.regex(/^[^/\s]+\/[^/\s]+$/, "Expected a GitHub repository in owner/name form"));

export const ManagedConfigSchema = v.strictObject({
  schemaVersion: v.literal(1),
  managedChats: v.pipe(v.array(v.pipe(v.string(), v.nonEmpty())), v.nonEmpty()),
  model: v.strictObject({
    provider: v.literal("openai-codex"),
    credential: v.literal(PI_AUTH_CREDENTIAL_REFERENCE),
  }),
  github: v.strictObject({
    kind: v.literal("personal-token"),
    credential: v.literal(GITHUB_CREDENTIAL_REFERENCE),
    defaultRepository: Repository,
    allowedRepositories: v.pipe(v.array(Repository), v.nonEmpty()),
  }),
});

export type ManagedConfig = v.InferOutput<typeof ManagedConfigSchema>;

export const GitHubCredentialSchema = v.strictObject({
  schemaVersion: v.literal(1),
  kind: v.literal("personal-token"),
  token: v.pipe(v.string(), v.nonEmpty()),
});

export type GitHubCredential = v.InferOutput<typeof GitHubCredentialSchema>;

const PiOAuthCredentialSchema = v.looseObject({
  type: v.literal("oauth"),
  access: v.pipe(v.string(), v.nonEmpty()),
  refresh: v.pipe(v.string(), v.nonEmpty()),
  expires: v.number(),
});

export const PiAuthSchema = v.object({
  "openai-codex": PiOAuthCredentialSchema,
});

export type PiAuth = v.InferOutput<typeof PiAuthSchema>;

export const createManagedConfig = (managedChats: readonly string[], defaultRepository: string): ManagedConfig => ({
  schemaVersion: 1,
  managedChats: [...managedChats],
  model: { provider: "openai-codex", credential: PI_AUTH_CREDENTIAL_REFERENCE },
  github: {
    kind: "personal-token",
    credential: GITHUB_CREDENTIAL_REFERENCE,
    defaultRepository,
    allowedRepositories: [defaultRepository],
  },
});
