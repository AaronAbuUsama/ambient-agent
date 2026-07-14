import { homedir } from "node:os";
import { posix, win32, type PlatformPath } from "node:path";

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
  const platform = options.platform ?? process.platform;
  const paths: PlatformPath = platform === "win32" ? win32 : posix;
  if (options.dataDirectory !== undefined) {
    const dataDirectory = options.dataDirectory.trim();
    if (!dataDirectory || !paths.isAbsolute(dataDirectory)) {
      throw new Error("The managed data directory must be an absolute path.");
    }
    return dataDirectory;
  }

  const home = options.homeDirectory ?? homedir();
  const environment = options.environment ?? process.env;

  if (platform === "win32") {
    const configured = environment.LOCALAPPDATA?.trim();
    const base = configured && win32.isAbsolute(configured) ? configured : win32.join(home, "AppData", "Local");
    return win32.join(base, "ambient-agent");
  }
  if (platform === "darwin") {
    return posix.join(home, "Library", "Application Support", "ambient-agent");
  }
  const configured = environment.XDG_DATA_HOME?.trim();
  const base = configured && posix.isAbsolute(configured) ? configured : posix.join(home, ".local", "share");
  return posix.join(base, "ambient-agent");
};

export const managedPaths = (options: ManagedPathEnvironment = {}): ManagedPaths => {
  const root = resolveManagedDataDirectory(options);
  const paths: PlatformPath = (options.platform ?? process.platform) === "win32" ? win32 : posix;
  const credentials = paths.join(root, "credentials");
  return {
    root,
    config: paths.join(root, "config.json"),
    credentials,
    githubCredential: paths.join(credentials, "github.json"),
    piAuthCredential: paths.join(credentials, "pi-auth.json"),
    applicationDatabase: paths.join(root, "application.sqlite"),
    flueDatabase: paths.join(root, "flue.sqlite"),
    whatsapp: paths.join(root, "whatsapp"),
    logs: paths.join(root, "logs"),
  };
};
