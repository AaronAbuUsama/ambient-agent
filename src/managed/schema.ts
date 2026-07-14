import * as v from "valibot";

const GITHUB_CREDENTIAL_REFERENCE = "github";
const PI_AUTH_CREDENTIAL_REFERENCE = "pi-auth";

const NonBlankString = v.pipe(v.string(), v.trim(), v.nonEmpty());
const Repository = v.pipe(
  NonBlankString,
  v.regex(/^[^/\s]+\/[^/\s]+$/, "Expected a GitHub repository in owner/name form"),
);
const ManagedChat = v.pipe(
  NonBlankString,
  v.regex(/^[^@\s]+@(g\.us|s\.whatsapp\.net)$/, "Expected a WhatsApp group or direct-chat JID"),
);

export const ManagedConfigSchema = v.pipe(
  v.strictObject({
    schemaVersion: v.literal(1),
    managedChats: v.pipe(v.array(ManagedChat), v.nonEmpty()),
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
  }),
  v.check(
    (config) =>
      config.github.allowedRepositories.some(
        (repository) => repository.toLowerCase() === config.github.defaultRepository.toLowerCase(),
      ),
    "The default GitHub repository must be included in allowedRepositories",
  ),
);

export type ManagedConfig = v.InferOutput<typeof ManagedConfigSchema>;

export const GitHubCredentialSchema = v.strictObject({
  schemaVersion: v.literal(1),
  kind: v.literal("personal-token"),
  token: NonBlankString,
});

export type GitHubCredential = v.InferOutput<typeof GitHubCredentialSchema>;

const PiOAuthCredentialSchema = v.looseObject({
  type: v.literal("oauth"),
  access: NonBlankString,
  refresh: NonBlankString,
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
