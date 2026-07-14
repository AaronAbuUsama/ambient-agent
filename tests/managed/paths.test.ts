import { describe, expect, it } from "vite-plus/test";
import { join } from "node:path";

import { managedPaths, resolveManagedDataDirectory } from "../../src/managed/paths.ts";

describe("managed data paths", () => {
  it("uses the macOS Application Support directory", () => {
    expect(
      resolveManagedDataDirectory({
        platform: "darwin",
        homeDirectory: "/Users/alice",
        environment: {},
      }),
    ).toBe(join("/Users/alice", "Library", "Application Support", "ambient-agent"));
  });

  it("honours XDG_DATA_HOME on Linux", () => {
    expect(
      resolveManagedDataDirectory({
        platform: "linux",
        homeDirectory: "/home/alice",
        environment: { XDG_DATA_HOME: "/data" },
      }),
    ).toBe(join("/data", "ambient-agent"));
  });

  it("uses LOCALAPPDATA on Windows", () => {
    expect(
      resolveManagedDataDirectory({
        platform: "win32",
        homeDirectory: "C:\\Users\\alice",
        environment: { LOCALAPPDATA: "D:\\Local" },
      }),
    ).toBe(join("D:\\Local", "ambient-agent"));
  });

  it("derives the complete stable skeleton from an injected root", () => {
    const paths = managedPaths({ dataDirectory: "/managed" });
    expect(paths).toEqual({
      root: "/managed",
      config: join("/managed", "config.json"),
      credentials: join("/managed", "credentials"),
      githubCredential: join("/managed", "credentials", "github.json"),
      piAuthCredential: join("/managed", "credentials", "pi-auth.json"),
      applicationDatabase: join("/managed", "application.sqlite"),
      flueDatabase: join("/managed", "flue.sqlite"),
      whatsapp: join("/managed", "whatsapp"),
      logs: join("/managed", "logs"),
    });
  });
});
