import { homedir } from "node:os";
import { join } from "node:path";

export interface ManagedPathEnvironment {
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly dataDirectory?: string;
}

export interface ManagedPaths {
  readonly root: string;
  readonly config: string;
  readonly credentials: string;
  readonly githubCredential: string;
  readonly piAuthCredential: string;
  readonly applicationDatabase: string;
  readonly flueDatabase: string;
  readonly whatsapp: string;
  readonly logs: string;
}

export const resolveManagedDataDirectory = (options: ManagedPathEnvironment = {}): string => {
  if (options.dataDirectory) return options.dataDirectory;

  const platform = options.platform ?? process.platform;
  const home = options.homeDirectory ?? homedir();
  const environment = options.environment ?? process.env;

  if (platform === "win32") {
    return join(environment.LOCALAPPDATA ?? join(home, "AppData", "Local"), "ambient-agent");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "ambient-agent");
  }
  return join(environment.XDG_DATA_HOME ?? join(home, ".local", "share"), "ambient-agent");
};

export const managedPaths = (options: ManagedPathEnvironment = {}): ManagedPaths => {
  const root = resolveManagedDataDirectory(options);
  const credentials = join(root, "credentials");
  return {
    root,
    config: join(root, "config.json"),
    credentials,
    githubCredential: join(credentials, "github.json"),
    piAuthCredential: join(credentials, "pi-auth.json"),
    applicationDatabase: join(root, "application.sqlite"),
    flueDatabase: join(root, "flue.sqlite"),
    whatsapp: join(root, "whatsapp"),
    logs: join(root, "logs"),
  };
};
