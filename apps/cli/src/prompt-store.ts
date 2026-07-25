import { readFile } from "node:fs/promises";

import { createPromptStore, type PromptStore, type StoredPrompt } from "@ambient-agent/engine/prompts/store.ts";
import { withManagedConfigurationSource } from "@ambient-agent/installation/configuration-source.ts";
import type { ManagedPaths } from "@ambient-agent/installation/paths.ts";

/**
 * The operator surface over the prompt store (#375). Editing a prompt is no longer a release, so it
 * needs a command: the runtime resolves every role's instructions and skill bodies from this store
 * at each agent initialization, which means a `set` or `revert` here lands on the next turn with no
 * restart and no redeploy.
 *
 * The store is seeded by the runtime, which is the only process that carries the shipped catalog.
 * These commands therefore read and write entries but never create them: against a data directory
 * the runtime has never booted, the store is empty and says so.
 *
 * It rides #366's single resolution seam rather than opening the database itself, so the CLI and the
 * runtime cannot disagree about which file this is or how it is opened.
 */
export const withPromptStore = async <T>(paths: ManagedPaths, use: (store: PromptStore) => T): Promise<T> =>
  await withManagedConfigurationSource(paths, (source) => use(createPromptStore(source.store.promptRows)));

export const renderPromptEntries = (entries: readonly StoredPrompt[]): string => {
  if (entries.length === 0) {
    return "The prompt store is empty. Start the runtime once — it seeds the store from the shipped prompts.\n";
  }
  const width = Math.max(...entries.map(({ id }) => id.length));
  return `${entries
    .map((entry) => {
      const state = entry.customised
        ? `customised (seeded from ${entry.seededVersion}${
            entry.seededVersion === entry.shippedVersion ? "" : `, shipped is now ${entry.shippedVersion}`
          })`
        : `shipped ${entry.shippedVersion}`;
      return `${entry.id.padEnd(width)}  ${entry.kind.padEnd(12)}  ${state}`;
    })
    .join("\n")}\n`;
};

export const readPromptBody = async (source: string): Promise<string> =>
  source === "-" ? await readStdin() : await readFile(source, "utf8");

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};
