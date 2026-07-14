import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CredentialStore, ModelAuth, OAuthCredential } from "@earendil-works/pi-ai";
import {
  loginOpenAICodexDeviceCode,
  openaiCodexOAuthProvider,
  type OAuthDeviceCodeInfo,
} from "@earendil-works/pi-ai/oauth";

export const CHATGPT_PROVIDER_ID = "openai-codex";

export type ChatGptAuthenticationErrorCode =
  | "cancelled"
  | "device-code-expired"
  | "timeout"
  | "provider-rejected"
  | "malformed-response"
  | "persistence-failed"
  | "missing"
  | "malformed"
  | "refresh-failed";

export class ChatGptAuthenticationError extends Error {
  override readonly name = "ChatGptAuthenticationError";

  constructor(
    readonly code: ChatGptAuthenticationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface DeviceCodeCallbacks {
  readonly onDeviceCode: (info: OAuthDeviceCodeInfo) => void;
  readonly onProgress?: (progress: { readonly phase: "waiting" | "complete" }) => void;
}

export type ChatGptAuthenticationStatus =
  | { readonly state: "missing" }
  | { readonly state: "malformed"; readonly message: string }
  | { readonly state: "expired-refreshable" }
  | { readonly state: "unusable"; readonly message: string }
  | { readonly state: "ready" };

export type ModelAuthorization = ModelAuth;

export interface ChatGptAuthentication {
  authenticate(callbacks: DeviceCodeCallbacks, signal?: AbortSignal): Promise<void>;
  inspect(): Promise<ChatGptAuthenticationStatus>;
  authorization(): Promise<ModelAuthorization>;
}

export interface ChatGptOAuthAdapter {
  login(callbacks: DeviceCodeCallbacks, signal?: AbortSignal): Promise<OAuthCredential>;
  refresh(credential: OAuthCredential): Promise<OAuthCredential>;
  authorization(credential: OAuthCredential): Promise<ModelAuthorization>;
}

export interface CreateChatGptAuthenticationOptions {
  readonly store: CredentialStore;
  readonly oauth?: ChatGptOAuthAdapter;
  readonly now?: () => number;
}

export interface ManagedChatGptCredentialStoreOptions {
  readonly path: string;
  readonly legacyPath?: string;
  readonly onLegacyMigration?: () => Promise<void>;
  readonly beforeCommit?: (temporaryPath: string, targetPath: string) => Promise<void>;
}

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_CREDENTIAL_BYTES = 1024 * 1024;
const LOCK_WAIT_MILLIS = 20;
const LOCK_TIMEOUT_MILLIS = 5_000;
const STALE_LOCK_MILLIS = 30_000;
const LOCK_OWNER_FILE = "owner.json";

const errorCode = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : undefined;

const delay = async (millis: number): Promise<void> => await new Promise((resolve) => setTimeout(resolve, millis));

const pathExists = async (path: string | undefined): Promise<boolean> => {
  if (path === undefined) return false;
  try {
    await lstat(path);
    return true;
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return false;
    throw cause;
  }
};

const ensurePrivateDirectory = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
  await chmod(path, DIRECTORY_MODE);
};

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return errorCode(cause) !== "ESRCH";
  }
};

const readPrivateJson = async (path: string): Promise<unknown | undefined> => {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const stat = await lstat(path);
    if (!stat.isFile()) throw new Error("The managed ChatGPT credential path is not a regular file.");
    if ((stat.mode & 0o777) !== FILE_MODE) {
      throw new Error("The managed ChatGPT credential file must have mode 0600.");
    }
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    handle = await open(path, constants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_CREDENTIAL_BYTES) {
      throw new Error("The managed ChatGPT credential file is not a supported private JSON file.");
    }
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== opened.size) throw new Error("The managed ChatGPT credential changed while it was read.");
    return JSON.parse(bytes.toString("utf8"));
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return undefined;
    throw cause;
  } finally {
    await handle?.close();
  }
};

const atomicWriteCredential = async (
  path: string,
  credential: OAuthCredential,
  beforeCommit?: ManagedChatGptCredentialStoreOptions["beforeCommit"],
): Promise<void> => {
  const directory = dirname(path);
  await ensurePrivateDirectory(directory);
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", FILE_MODE);
    await handle.writeFile(`${JSON.stringify(credential, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await beforeCommit?.(temporary, path);
    await rename(temporary, path);
    await chmod(path, FILE_MODE);
    const directoryHandle = await open(directory, constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
};

const acquireCredentialLock = async (path: string): Promise<() => Promise<void>> => {
  const lockPath = `${path}.lock`;
  const started = Date.now();
  await ensurePrivateDirectory(dirname(path));
  while (true) {
    try {
      await mkdir(lockPath, { mode: DIRECTORY_MODE });
      await chmod(lockPath, DIRECTORY_MODE);
      const owner = await open(join(lockPath, LOCK_OWNER_FILE), "wx", FILE_MODE);
      try {
        await owner.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), "utf8");
        await owner.sync();
      } catch (cause) {
        await rm(lockPath, { recursive: true, force: true });
        throw cause;
      } finally {
        await owner.close();
      }
      return async () => await rm(lockPath, { recursive: true, force: true });
    } catch (cause) {
      if (errorCode(cause) !== "EEXIST") throw cause;
      try {
        const lock = await lstat(lockPath);
        if (!lock.isDirectory()) throw new Error("The managed ChatGPT credential lock is not a directory.");
        let owner: unknown;
        try {
          owner = await readPrivateJson(join(lockPath, LOCK_OWNER_FILE));
        } catch {
          owner = undefined;
        }
        const ownerPid =
          typeof owner === "object" && owner !== null && typeof (owner as Record<string, unknown>).pid === "number"
            ? (owner as Record<string, number>).pid
            : undefined;
        const stale =
          ownerPid !== undefined ? !processIsAlive(ownerPid) : Date.now() - lock.mtimeMs > STALE_LOCK_MILLIS;
        if (stale) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (inspectionCause) {
        if (errorCode(inspectionCause) !== "ENOENT") throw inspectionCause;
        continue;
      }
      if (Date.now() - started >= LOCK_TIMEOUT_MILLIS) {
        throw new Error("Timed out waiting for the managed ChatGPT credential lock.");
      }
      await delay(LOCK_WAIT_MILLIS);
    }
  }
};

const assertProvider = (providerId: string): void => {
  if (providerId !== CHATGPT_PROVIDER_ID) {
    throw new Error("The managed ChatGPT credential store accepts only openai-codex.");
  }
};

export const createManagedChatGptCredentialStore = (options: ManagedChatGptCredentialStoreOptions): CredentialStore => {
  const readUnlocked = async (): Promise<OAuthCredential | undefined> => {
    const current = await readPrivateJson(options.path);
    if (current !== undefined) {
      const credential = validateChatGptOAuthCredential(current);
      if (options.legacyPath !== undefined && (await pathExists(options.legacyPath))) {
        await options.onLegacyMigration?.();
        await rm(options.legacyPath, { force: true });
      }
      return credential;
    }
    if (options.legacyPath === undefined) return undefined;
    const legacy = await readPrivateJson(options.legacyPath);
    if (legacy === undefined) return undefined;
    if (typeof legacy !== "object" || legacy === null) {
      throw new Error("The provisional managed ChatGPT credential is malformed.");
    }
    const migrated = validateChatGptOAuthCredential((legacy as Record<string, unknown>)[CHATGPT_PROVIDER_ID]);
    await atomicWriteCredential(options.path, migrated, options.beforeCommit);
    await options.onLegacyMigration?.();
    await rm(options.legacyPath, { force: true });
    return migrated;
  };

  const locked = async <T>(task: () => Promise<T>): Promise<T> => {
    const release = await acquireCredentialLock(options.path);
    try {
      return await task();
    } finally {
      await release();
    }
  };

  return {
    async read(providerId) {
      assertProvider(providerId);
      if (
        !(await pathExists(options.path)) &&
        !(await pathExists(options.legacyPath)) &&
        !(await pathExists(`${options.path}.lock`))
      ) {
        return undefined;
      }
      return await locked(readUnlocked);
    },
    async modify(providerId, change) {
      assertProvider(providerId);
      return await locked(async () => {
        const current = await readUnlocked();
        const next = await change(current);
        if (next === undefined) return current;
        if (next.type !== "oauth") throw new Error("Only a ChatGPT OAuth credential may be stored.");
        const credential = validateChatGptOAuthCredential(next);
        await atomicWriteCredential(options.path, credential, options.beforeCommit);
        return credential;
      });
    },
    async delete(providerId) {
      assertProvider(providerId);
      await locked(async () => {
        await rm(options.path, { force: true });
      });
    },
  };
};

const nonBlank = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

const loginFailure = (cause: unknown, signal?: AbortSignal): ChatGptAuthenticationError => {
  const providerMessage = cause instanceof Error ? cause.message : String(cause);
  const abortReason = signal?.aborted ? signal.reason : undefined;
  if (
    abortReason instanceof Error &&
    (abortReason.name === "TimeoutError" || /timeout|timed out/i.test(abortReason.message))
  ) {
    return new ChatGptAuthenticationError("timeout", "ChatGPT authentication timed out; try again.", { cause });
  }
  if (signal?.aborted || /cancel/i.test(providerMessage)) {
    return new ChatGptAuthenticationError("cancelled", "ChatGPT device-code authentication was cancelled.", {
      cause,
    });
  }
  if (/device flow timed out/i.test(providerMessage)) {
    return new ChatGptAuthenticationError(
      "device-code-expired",
      "The ChatGPT device code expired; start login again.",
      {
        cause,
      },
    );
  }
  if (/timeout|timed out/i.test(providerMessage)) {
    return new ChatGptAuthenticationError("timeout", "ChatGPT authentication timed out; try again.", { cause });
  }
  if (/invalid|malformed/i.test(providerMessage)) {
    return new ChatGptAuthenticationError(
      "malformed-response",
      "ChatGPT returned a malformed authentication response; try again.",
      { cause },
    );
  }
  return new ChatGptAuthenticationError(
    "provider-rejected",
    "ChatGPT rejected the device-code authentication request; try again.",
    { cause },
  );
};

export const validateChatGptOAuthCredential = (value: unknown): OAuthCredential => {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as Record<string, unknown>).type !== "oauth" ||
    !nonBlank((value as Record<string, unknown>).access) ||
    !nonBlank((value as Record<string, unknown>).refresh) ||
    typeof (value as Record<string, unknown>).expires !== "number" ||
    !Number.isFinite((value as Record<string, unknown>).expires)
  ) {
    throw new Error("The managed ChatGPT OAuth credential is malformed.");
  }
  return value as OAuthCredential;
};

export const piChatGptOAuthAdapter = (): ChatGptOAuthAdapter => ({
  login: async (callbacks, signal) => {
    const credential = await loginOpenAICodexDeviceCode({
      signal,
      onDeviceCode: (info) => {
        callbacks.onDeviceCode(info);
        callbacks.onProgress?.({ phase: "waiting" });
      },
    });
    return { type: "oauth", ...credential };
  },
  refresh: async (credential) =>
    validateChatGptOAuthCredential({
      type: "oauth",
      ...(await openaiCodexOAuthProvider.refreshToken(credential)),
    }),
  authorization: async (credential) => ({ apiKey: openaiCodexOAuthProvider.getApiKey(credential) }),
});

export const createChatGptAuthentication = (options: CreateChatGptAuthenticationOptions): ChatGptAuthentication => {
  const oauth = options.oauth ?? piChatGptOAuthAdapter();
  const now = options.now ?? Date.now;
  let unusableMessage: string | undefined;

  return {
    async authenticate(callbacks, signal) {
      let credential: OAuthCredential;
      try {
        credential = validateChatGptOAuthCredential(await oauth.login(callbacks, signal));
      } catch (cause) {
        if (cause instanceof ChatGptAuthenticationError) throw cause;
        throw loginFailure(cause, signal);
      }
      try {
        await options.store.modify(CHATGPT_PROVIDER_ID, async () => credential);
      } catch (cause) {
        throw new ChatGptAuthenticationError(
          "persistence-failed",
          "ChatGPT login succeeded, but the managed credential could not be saved; login is not ready.",
          { cause },
        );
      }
      unusableMessage = undefined;
      callbacks.onProgress?.({ phase: "complete" });
    },

    async inspect() {
      if (unusableMessage !== undefined) return { state: "unusable", message: unusableMessage };
      let stored;
      try {
        stored = await options.store.read(CHATGPT_PROVIDER_ID);
      } catch {
        return { state: "malformed", message: "The managed ChatGPT OAuth credential could not be read." };
      }
      if (stored === undefined) return { state: "missing" };
      let credential;
      try {
        credential = validateChatGptOAuthCredential(stored);
      } catch (cause) {
        return { state: "malformed", message: cause instanceof Error ? cause.message : String(cause) };
      }
      return credential.expires <= now() ? { state: "expired-refreshable" } : { state: "ready" };
    },

    async authorization() {
      try {
        let current;
        try {
          current = await options.store.read(CHATGPT_PROVIDER_ID);
        } catch (cause) {
          throw new ChatGptAuthenticationError(
            "persistence-failed",
            "The managed ChatGPT credential could not be read; run ambient-agent doctor.",
            { cause },
          );
        }
        if (current === undefined) {
          throw new ChatGptAuthenticationError("missing", "ChatGPT authentication is missing; run ambient-agent init.");
        }
        let credential: OAuthCredential;
        try {
          credential = validateChatGptOAuthCredential(current);
        } catch (cause) {
          throw new ChatGptAuthenticationError(
            "malformed",
            "The managed ChatGPT OAuth credential is malformed; run ambient-agent doctor.",
            { cause },
          );
        }
        if (credential.expires <= now()) {
          let refreshFailed = false;
          let refreshed;
          try {
            refreshed = await options.store.modify(CHATGPT_PROVIDER_ID, async (latest) => {
              if (latest === undefined) return undefined;
              const validated = validateChatGptOAuthCredential(latest);
              if (validated.expires > now()) return undefined;
              try {
                return validateChatGptOAuthCredential(await oauth.refresh(validated));
              } catch (cause) {
                refreshFailed = true;
                throw cause;
              }
            });
          } catch (cause) {
            throw new ChatGptAuthenticationError(
              refreshFailed ? "refresh-failed" : "persistence-failed",
              refreshFailed
                ? "ChatGPT rejected the credential refresh; run ambient-agent init to authenticate again."
                : "ChatGPT refreshed the credential, but the rotation could not be saved; authorization is not ready.",
              { cause },
            );
          }
          if (refreshed === undefined) {
            throw new ChatGptAuthenticationError(
              "missing",
              "ChatGPT authentication was removed during refresh; run ambient-agent init.",
            );
          }
          credential = validateChatGptOAuthCredential(refreshed);
        }
        let authorization: ModelAuthorization;
        try {
          authorization = await oauth.authorization(credential);
        } catch (cause) {
          throw new ChatGptAuthenticationError(
            "provider-rejected",
            "ChatGPT could not derive model authorization from the managed credential.",
            { cause },
          );
        }
        if (!nonBlank(authorization.apiKey)) {
          throw new ChatGptAuthenticationError(
            "malformed",
            "ChatGPT authorization did not contain a usable token; run ambient-agent init.",
          );
        }
        unusableMessage = undefined;
        return authorization;
      } catch (cause) {
        unusableMessage = cause instanceof Error ? cause.message : String(cause);
        throw cause;
      }
    },
  };
};
