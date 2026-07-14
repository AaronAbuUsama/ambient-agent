import { describe, expect, it } from "vite-plus/test";
import { posix, win32 } from "node:path";

import { managedPaths, resolveManagedDataDirectory } from "../../src/managed/paths.ts";

describe("managed data paths", () => {
  it("uses the macOS Application Support directory", () => {
    expect(
      resolveManagedDataDirectory({
        platform: "darwin",
        homeDirectory: "/Users/alice",
        environment: {},
      }),
    ).toBe(posix.join("/Users/alice", "Library", "Application Support", "ambient-agent"));
  });

  it("honours XDG_DATA_HOME on Linux", () => {
    expect(
      resolveManagedDataDirectory({
        platform: "linux",
        homeDirectory: "/home/alice",
        environment: { XDG_DATA_HOME: "/data" },
      }),
    ).toBe(posix.join("/data", "ambient-agent"));
  });

  it("uses LOCALAPPDATA on Windows", () => {
    expect(
      resolveManagedDataDirectory({
        platform: "win32",
        homeDirectory: "C:\\Users\\alice",
        environment: { LOCALAPPDATA: "D:\\Local" },
      }),
    ).toBe(win32.join("D:\\Local", "ambient-agent"));
  });

  it("uses the selected platform path dialect for every derived Windows path", () => {
    expect(managedPaths({ platform: "win32", dataDirectory: "D:\\Agent" })).toEqual({
      root: "D:\\Agent",
      config: "D:\\Agent\\config.json",
      credentials: "D:\\Agent\\credentials",
      githubCredential: "D:\\Agent\\credentials\\github.json",
      piAuthCredential: "D:\\Agent\\credentials\\pi-auth.json",
      applicationDatabase: "D:\\Agent\\application.sqlite",
      flueDatabase: "D:\\Agent\\flue.sqlite",
      whatsapp: "D:\\Agent\\whatsapp",
      logs: "D:\\Agent\\logs",
    });
  });

  it("ignores empty or relative environment overrides and rejects relative explicit roots", () => {
    expect(
      resolveManagedDataDirectory({
        platform: "linux",
        homeDirectory: "/home/alice",
        environment: { XDG_DATA_HOME: "relative-data" },
      }),
    ).toBe("/home/alice/.local/share/ambient-agent");
    expect(
      resolveManagedDataDirectory({
        platform: "linux",
        homeDirectory: "/home/alice",
        environment: { XDG_DATA_HOME: "   " },
      }),
    ).toBe("/home/alice/.local/share/ambient-agent");
    expect(() => resolveManagedDataDirectory({ platform: "linux", dataDirectory: "relative-data" })).toThrow(
      "absolute path",
    );
  });

  it("rejects a relative fallback home without rejecting an absolute environment override", () => {
    expect(() =>
      resolveManagedDataDirectory({
        platform: "linux",
        homeDirectory: "relative-home",
        environment: {},
      }),
    ).toThrow("home directory must be an absolute path");
    expect(() =>
      resolveManagedDataDirectory({
        platform: "win32",
        homeDirectory: "relative-home",
        environment: {},
      }),
    ).toThrow("home directory must be an absolute path");
    expect(
      resolveManagedDataDirectory({
        platform: "linux",
        homeDirectory: "relative-home",
        environment: { XDG_DATA_HOME: "/data" },
      }),
    ).toBe("/data/ambient-agent");
  });

  it("derives the complete stable skeleton from an injected root", () => {
    const paths = managedPaths({ platform: "linux", dataDirectory: "/managed" });
    expect(paths).toEqual({
      root: "/managed",
      config: posix.join("/managed", "config.json"),
      credentials: posix.join("/managed", "credentials"),
      githubCredential: posix.join("/managed", "credentials", "github.json"),
      piAuthCredential: posix.join("/managed", "credentials", "pi-auth.json"),
      applicationDatabase: posix.join("/managed", "application.sqlite"),
      flueDatabase: posix.join("/managed", "flue.sqlite"),
      whatsapp: posix.join("/managed", "whatsapp"),
      logs: posix.join("/managed", "logs"),
    });
  });
});
