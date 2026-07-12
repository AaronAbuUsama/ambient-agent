/**
 * The config service. `CONFIG` is the one thing new Eve/gateway code imports
 * to read settings — never the ambient environment.
 *
 *   import { CONFIG } from "../config/index.ts";
 *   const token = CONFIG.github.token;   // lazily loads ~/.wa-agent/config.json
 *
 * Loading is LAZY: importing this module never touches the disk, so a missing
 * config file can't crash unrelated code at import time. The file is read,
 * parsed, and validated on the first property access (or first `getConfig()`
 * call), then cached. Every failure — no file, bad JSON, wrong shape — throws
 * a `ConfigError` whose message names the path and the exact problem.
 *
 * Tests call `loadConfig(path)` directly for deterministic, file-scoped loads.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { AppConfigSchema, DEFAULT_CONFIG_PATH, type AppConfig } from "./schema.ts";

export { DEFAULT_CONFIG_PATH, type AppConfig } from "./schema.ts";

/** Thrown for every config failure, with a message a human can act on. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/**
 * Read, parse, and validate the config at `filePath` (defaults to
 * `~/.wa-agent/config.json`). Returns the typed `AppConfig` or throws a
 * `ConfigError` with a clear, actionable message. Pure: no caching, no globals
 * — good for tests and for the loader that backs `getConfig()`.
 */
export function loadConfig(filePath: string = DEFAULT_CONFIG_PATH): AppConfig {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ConfigError(
        `No config file at ${filePath}. Create one — see config.sample.json in the repo root for the expected shape.`,
      );
    }
    throw new ConfigError(`Could not read config file at ${filePath}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`Config file at ${filePath} is not valid JSON: ${(err as Error).message}`);
  }

  const result = AppConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(`Invalid config at ${filePath}:\n${formatIssues(result.error)}`);
  }
  return result.data;
}

/** Turn a Zod error into a readable, one-issue-per-line list keyed by field. */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.join(".") : "(root)";
      return `  • ${path}: ${issue.message}`;
    })
    .join("\n");
}

let cached: AppConfig | undefined;

/**
 * The cached app config: loads from the default path on first access and
 * memoizes it, so repeated `CONFIG.*` reads don't re-hit the disk. Tests (or
 * any caller needing a specific file) call `loadConfig(path)` directly instead.
 */
export function getConfig(): AppConfig {
  return (cached ??= loadConfig());
}

/** Clear the memoized config so the next `getConfig()`/`CONFIG` access reloads. */
export function resetConfig(): void {
  cached = undefined;
}

/**
 * Ergonomic, lazy view of the config: `CONFIG.github.token` loads and caches
 * on first access. Use this in app code; use `getConfig()`/`loadConfig()` when
 * you need to pass an explicit path.
 */
export const CONFIG: AppConfig = new Proxy({} as AppConfig, {
  get: (_target, prop: keyof AppConfig) => getConfig()[prop],
});
