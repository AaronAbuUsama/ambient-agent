import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => join(here, "fixtures", name);

describe("loadConfig — valid files", () => {
  it("loads a full config and returns the typed values", () => {
    const cfg = loadConfig(fixture("valid.json"));

    expect(cfg.whatsapp).toEqual({
      chats: ["120363111@g.us", "120363222@g.us"],
      botLid: "98765@lid",
      allowDm: true,
    });
    expect(cfg.github).toEqual({
      token: "ghp_testtoken",
      repo: "acme/widgets",
      allowedRepos: ["acme/widgets", "acme/gadgets"],
    });
    expect(cfg.model).toEqual({
      source: "openai",
      openaiKey: "sk-testkey",
      modelId: "gpt-4o",
    });
  });

  it("applies defaults for omitted optional fields", () => {
    const cfg = loadConfig(fixture("minimal.json"));

    // whatsapp.chats → [], whatsapp.allowDm → false, github.allowedRepos → []
    expect(cfg.whatsapp).toEqual({ chats: [], allowDm: false });
    expect(cfg.whatsapp.botLid).toBeUndefined();
    expect(cfg.github.allowedRepos).toEqual([]);
    expect(cfg.model).toEqual({ source: "codex" });
  });

  it("accepts the repo's committed config.sample.json", () => {
    const sample = join(here, "..", "..", "config.sample.json");
    const cfg = loadConfig(sample);
    expect(cfg.github.repo).toBe("your-org/your-repo");
    expect(cfg.model.source).toBe("openai");
  });
});

describe("loadConfig — failures are loud and helpful", () => {
  it("names the path when the file is missing", () => {
    const path = fixture("does-not-exist.json");
    expect(() => loadConfig(path)).toThrow(ConfigError);
    expect(() => loadConfig(path)).toThrow(/No config file at .*does-not-exist\.json/);
    // The message points the user at the sample.
    expect(() => loadConfig(path)).toThrow(/config\.sample\.json/);
  });

  it("reports malformed JSON with the path", () => {
    expect(() => loadConfig(fixture("bad-json.json"))).toThrow(ConfigError);
    expect(() => loadConfig(fixture("bad-json.json"))).toThrow(/not valid JSON/);
  });

  it("reports a schema violation with the offending field", () => {
    expect(() => loadConfig(fixture("missing-token.json"))).toThrow(ConfigError);
    expect(() => loadConfig(fixture("missing-token.json"))).toThrow(/github\.token/);
  });

  it("rejects an openai source with no key (cross-field rule)", () => {
    expect(() => loadConfig(fixture("openai-no-key.json"))).toThrow(ConfigError);
    expect(() => loadConfig(fixture("openai-no-key.json"))).toThrow(/model\.openaiKey is required/);
  });
});

describe("guard: the config module never reads process.env", () => {
  it("has zero process.env references in src/config", () => {
    const dir = join(here, "..", "..", "src", "config");
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => readFileSync(join(dir, f), "utf8").includes("process.env"));

    expect(offenders, `process.env found in src/config/${offenders.join(", ")}`).toEqual([]);
  });
});
