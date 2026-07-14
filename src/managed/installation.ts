import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import * as v from "valibot";

import { managedPaths, type ManagedPathEnvironment, type ManagedPaths } from "./paths.js";
import {
  createManagedConfig,
  GitHubCredentialSchema,
  ManagedConfigSchema,
  PiAuthSchema,
  type GitHubCredential,
  type ManagedConfig,
  type PiAuth,
} from "./schema.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export type InstallationState = "unconfigured" | "configured" | "damaged";

export interface InstallationDiagnostic {
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly remediation: string;
}

export interface InstallationInspection {
  readonly state: InstallationState;
  readonly dataDirectory: string;
  readonly diagnostics: readonly InstallationDiagnostic[];
}

export interface InstallManagedDataInput extends ManagedPathEnvironment {
  readonly managedChats: readonly string[];
  readonly defaultRepository: string;
  readonly githubToken: string;
  readonly piAuth: unknown;
}

export interface InstallManagedDataResult {
  readonly created: boolean;
  readonly inspection: InstallationInspection;
}

const diagnostic = (code: string, path: string, message: string, remediation: string): InstallationDiagnostic => ({
  code,
  path,
  message,
  remediation,
});

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const modeOf = (mode: number): number => mode & 0o777;

const inspectDirectory = async (
  path: string,
  label: string,
  enforcePermissions: boolean,
): Promise<readonly InstallationDiagnostic[]> => {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory()) {
      return [
        diagnostic(
          "path.not-directory",
          path,
          `${label} is not a directory.`,
          `Move it aside and run ambient-agent init again.`,
        ),
      ];
    }
    if (enforcePermissions && modeOf(stat.mode) !== DIRECTORY_MODE) {
      return [
        diagnostic(
          "permissions.directory",
          path,
          `${label} must have mode 0700.`,
          `Run chmod 700 ${JSON.stringify(path)}.`,
        ),
      ];
    }
    return [];
  } catch {
    return [
      diagnostic(
        "path.missing-directory",
        path,
        `${label} is missing.`,
        `Restore it or move the managed data directory aside and run ambient-agent init.`,
      ),
    ];
  }
};

const inspectFile = async (
  path: string,
  label: string,
  enforcePermissions: boolean,
): Promise<readonly InstallationDiagnostic[]> => {
  try {
    const stat = await lstat(path);
    if (!stat.isFile()) {
      return [
        diagnostic(
          "path.not-file",
          path,
          `${label} is not a regular file.`,
          `Replace it with a regular file and run ambient-agent doctor.`,
        ),
      ];
    }
    if (enforcePermissions && modeOf(stat.mode) !== FILE_MODE) {
      return [
        diagnostic("permissions.file", path, `${label} must have mode 0600.`, `Run chmod 600 ${JSON.stringify(path)}.`),
      ];
    }
    return [];
  } catch {
    return [
      diagnostic(
        "path.missing-file",
        path,
        `${label} is missing.`,
        `Restore it or move the managed data directory aside and run ambient-agent init.`,
      ),
    ];
  }
};

const inspectJson = async <TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
  path: string,
  label: string,
  schema: TSchema,
): Promise<readonly InstallationDiagnostic[]> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return [
      diagnostic(
        "json.invalid",
        path,
        `${label} is not valid JSON.`,
        `Repair or replace ${JSON.stringify(path)}, then run ambient-agent doctor.`,
      ),
    ];
  }
  const result = v.safeParse(schema, parsed);
  return result.success
    ? []
    : [
        diagnostic(
          "schema.invalid",
          path,
          `${label} does not match the supported schema.`,
          `Repair or replace ${JSON.stringify(path)}, then run ambient-agent doctor.`,
        ),
      ];
};

const inspectConfigReferences = async (path: string): Promise<readonly InstallationDiagnostic[]> => {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return [];
  }
  if (typeof value !== "object" || value === null) return [];
  const config = value as Record<string, unknown>;
  const model =
    typeof config.model === "object" && config.model !== null ? (config.model as Record<string, unknown>) : undefined;
  const github =
    typeof config.github === "object" && config.github !== null
      ? (config.github as Record<string, unknown>)
      : undefined;
  const issues: InstallationDiagnostic[] = [];
  if (model?.credential !== "pi-auth") {
    issues.push(
      diagnostic(
        "credential.reference",
        path,
        "The model credential reference must be pi-auth.",
        "Set model.credential to pi-auth and run ambient-agent doctor.",
      ),
    );
  }
  if (github?.credential !== "github") {
    issues.push(
      diagnostic(
        "credential.reference",
        path,
        "The GitHub credential reference must be github.",
        "Set github.credential to github and run ambient-agent doctor.",
      ),
    );
  }
  return issues;
};

export const inspectManagedData = async (options: ManagedPathEnvironment = {}): Promise<InstallationInspection> => {
  const paths = managedPaths(options);
  if (!(await exists(paths.root))) {
    return {
      state: "unconfigured",
      dataDirectory: paths.root,
      diagnostics: [
        diagnostic("installation.missing", paths.root, "Ambient Agent is not configured.", "Run ambient-agent init."),
      ],
    };
  }

  const enforcePermissions = (options.platform ?? process.platform) !== "win32";
  const diagnostics = [
    ...(await inspectDirectory(paths.root, "Managed data directory", enforcePermissions)),
    ...(await inspectDirectory(paths.credentials, "Credential directory", enforcePermissions)),
    ...(await inspectDirectory(paths.whatsapp, "WhatsApp data directory", enforcePermissions)),
    ...(await inspectDirectory(paths.logs, "Log directory", enforcePermissions)),
    ...(await inspectFile(paths.config, "Configuration file", enforcePermissions)),
    ...(await inspectFile(paths.githubCredential, "GitHub credential file", enforcePermissions)),
    ...(await inspectFile(paths.piAuthCredential, "Pi credential file", enforcePermissions)),
    ...(await inspectFile(paths.applicationDatabase, "Application database", enforcePermissions)),
    ...(await inspectFile(paths.flueDatabase, "Flue database", enforcePermissions)),
  ];

  if (await exists(paths.config)) {
    diagnostics.push(...(await inspectJson(paths.config, "Configuration file", ManagedConfigSchema)));
    diagnostics.push(...(await inspectConfigReferences(paths.config)));
  }
  if (await exists(paths.githubCredential))
    diagnostics.push(...(await inspectJson(paths.githubCredential, "GitHub credential file", GitHubCredentialSchema)));
  if (await exists(paths.piAuthCredential))
    diagnostics.push(...(await inspectJson(paths.piAuthCredential, "Pi credential file", PiAuthSchema)));

  return {
    state: diagnostics.length === 0 ? "configured" : "damaged",
    dataDirectory: paths.root,
    diagnostics,
  };
};

const writeSecureFile = async (path: string, contents: string): Promise<void> => {
  const handle = await open(path, "wx", FILE_MODE);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, FILE_MODE);
};

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const createSkeleton = async (
  paths: ManagedPaths,
  config: ManagedConfig,
  github: GitHubCredential,
  piAuth: PiAuth,
): Promise<void> => {
  await mkdir(paths.root, { mode: DIRECTORY_MODE });
  await chmod(paths.root, DIRECTORY_MODE);
  await mkdir(paths.credentials, { mode: DIRECTORY_MODE });
  await mkdir(paths.whatsapp, { mode: DIRECTORY_MODE });
  await mkdir(paths.logs, { mode: DIRECTORY_MODE });
  await writeSecureFile(paths.config, json(config));
  await writeSecureFile(paths.githubCredential, json(github));
  await writeSecureFile(paths.piAuthCredential, json(piAuth));
  await writeSecureFile(paths.applicationDatabase, "");
  await writeSecureFile(paths.flueDatabase, "");
};

export const installManagedData = async (input: InstallManagedDataInput): Promise<InstallManagedDataResult> => {
  const targetPaths = managedPaths(input);
  const before = await inspectManagedData(input);
  if (before.state === "configured") return { created: false, inspection: before };
  if (before.state === "damaged") {
    throw new Error(`Refusing to replace damaged managed data at ${targetPaths.root}; run ambient-agent doctor.`);
  }

  const configResult = v.safeParse(
    ManagedConfigSchema,
    createManagedConfig(input.managedChats, input.defaultRepository),
  );
  if (!configResult.success) throw new Error("Setup values do not form a valid Ambient Agent configuration.");
  const githubResult = v.safeParse(GitHubCredentialSchema, {
    schemaVersion: 1,
    kind: "personal-token",
    token: input.githubToken,
  });
  if (!githubResult.success) throw new Error("The GitHub token must not be empty.");
  const piResult = v.safeParse(PiAuthSchema, input.piAuth);
  if (!piResult.success) throw new Error("The Pi auth file must contain an openai-codex OAuth credential.");

  await mkdir(dirname(targetPaths.root), { recursive: true, mode: DIRECTORY_MODE });
  const lockPath = join(dirname(targetPaths.root), `.${basename(targetPaths.root)}.setup.lock`);
  try {
    await mkdir(lockPath, { mode: DIRECTORY_MODE });
  } catch {
    throw new Error(`Another setup is already running for ${targetPaths.root}.`);
  }

  const stagingRoot = join(
    dirname(targetPaths.root),
    `.${basename(targetPaths.root)}.setup-${process.pid}-${randomUUID()}`,
  );
  try {
    if (await exists(targetPaths.root)) {
      const current = await inspectManagedData(input);
      if (current.state === "configured") return { created: false, inspection: current };
      throw new Error(`Refusing to replace existing managed data at ${targetPaths.root}.`);
    }
    const stagingPaths = managedPaths({ dataDirectory: stagingRoot });
    await createSkeleton(stagingPaths, configResult.output, githubResult.output, piResult.output);
    await rename(stagingRoot, targetPaths.root);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
    await rm(lockPath, { recursive: true, force: true });
  }

  const inspection = await inspectManagedData(input);
  if (inspection.state !== "configured") {
    throw new Error(`Managed data verification failed at ${targetPaths.root}; run ambient-agent doctor.`);
  }
  return { created: true, inspection };
};
