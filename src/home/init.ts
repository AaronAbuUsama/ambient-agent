import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Resolve the Ambient home (`~/.ambient`; AMBIENT_HOME overrides for rigs and tests). */
export function ambientHome(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.AMBIENT_HOME ?? join(homedir(), ".ambient");
}

const seedConfig = `# Ambient deployment configuration. Restart-class; operator-owned.
# Secrets never live here — credential entries name environment variables.
account: main

# master:
#   chatId: "<the master's direct chat id>"  # the admin seat the Root occupies

# providers:
#   qwen:
#     adapter: openai-compatible
#     baseUrl: https://dashscope-intl.aliyuncs.com/compatible-mode/v1
#     credential: { env: [QWEN_API_KEY] }

# roles:
#   conversation: { provider: qwen, model: qwen3.6-flash }
#   memory: { provider: qwen, model: qwen3.6-flash }
`;

const seedReadme = `# The Ambient home

Ambient owns this directory. One rule carries everything: everything outside
state/ is yours and the Root's; everything inside state/ is Ambient's alone —
never edit it.

  config.yaml       deployment configuration (restart to apply)
  skills/           home-scoped skills (SKILL.md folders)
  chats/<slug>/     one folder per active chat; mandate.yaml is the grant
  state/            machine-owned: database, WhatsApp session, logs

Activate a chat with \`ambient activate\`; check health with \`ambient doctor\`.
This file is regenerable; edits may be lost.
`;

/**
 * Create the Ambient home tree (ADR 0001). Idempotent: only missing pieces
 * are created, and an existing config.yaml or README.md is never overwritten.
 * Returns the home-relative paths it created.
 */
export function initHome(home: string): readonly string[] {
  const created: string[] = [];
  const directory = (relative: string): void => {
    const path = join(home, relative);
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: true });
      created.push(`${relative}/`);
    }
  };
  const seed = (relative: string, content: string): void => {
    const path = join(home, relative);
    if (!existsSync(path)) {
      writeFileSync(path, content);
      created.push(relative);
    }
  };
  directory("chats");
  directory("skills");
  directory(join("state", "logs"));
  seed("config.yaml", seedConfig);
  seed("README.md", seedReadme);
  return created;
}
