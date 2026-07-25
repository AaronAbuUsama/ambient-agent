import { createHash } from "node:crypto";

import { defineSkill, type SkillReference } from "@flue/runtime";
import { FAILSAFE_SCHEMA, load } from "js-yaml";

import { createFlueGlobal } from "../shared/flue-global.ts";

/**
 * The prompt store (#375): every role's instructions and every mounted skill body resolve from here
 * at agent initialization instead of from a compiled-in constant. Editing a prompt stops being a
 * release.
 *
 * Two kinds, one table. `instructions` is the plain-text system prompt of one role; `skill` is a
 * whole SKILL.md document (frontmatter + body) that is turned back into a Flue skill reference at
 * initialization. The kind decides what "valid" means on save, which is why it is stored rather
 * than inferred from the id.
 */
export type PromptEntryKind = "instructions" | "skill";

/**
 * One entry as the repository ships it. `body` is the shipped text; `files` are the auxiliary
 * files a skill directory carries beside SKILL.md (references/*), which travel with the shipped
 * build rather than the store — they are shipped assets, not the edited surface.
 */
export interface ShippedPrompt {
  readonly id: string;
  readonly kind: PromptEntryKind;
  readonly body: string;
  readonly files?: Readonly<Record<string, string>>;
}

/**
 * One stored entry — the customised / seed-version / revert shape. #379 (the Agents screens) renders
 * this directly and quotes this type rather than re-deriving it:
 *
 * - `body` is what the agent actually gets. Always.
 * - `customised` is true from the moment {@link PromptStore.save} accepts an edit until
 *   {@link PromptStore.revert} puts the shipped text back. It is stored, not inferred, so an edit
 *   that happens to equal the shipped text is still visibly an edit.
 * - `seededVersion` is the shipped version this entry was last seeded (or reverted) from. It is
 *   deliberately FROZEN while customised, so `seededVersion !== shippedVersion` is exactly
 *   "this customisation predates the shipped prompt it was forked from" — divergence, detectable.
 * - `shippedBody` / `shippedVersion` are the CURRENT shipped text and its version, reconciled against
 *   the catalog on every boot for every entry including customised ones (a boot that ships the same
 *   text writes nothing). They are what revert restores and what a diff view renders against, and
 *   they are what lets a process that has no compiled-in catalog — the CLI, the control plane —
 *   revert an entry.
 */
export interface StoredPrompt {
  readonly id: string;
  readonly kind: PromptEntryKind;
  readonly body: string;
  readonly customised: boolean;
  readonly seededVersion: string;
  readonly shippedBody: string;
  readonly shippedVersion: string;
  readonly updatedAt: string;
}

/**
 * The persistence port. One row in, one row out — every rule about seeding, customisation and
 * revert lives in {@link createPromptStore} so the SQLite-backed and in-memory stores cannot
 * disagree about them. `put` must be atomic: a failed write leaves the previous row intact, which
 * is what keeps an agent from ever resolving a partially written prompt.
 */
export interface PromptRows {
  get(id: string): StoredPrompt | undefined;
  list(): readonly StoredPrompt[];
  put(row: StoredPrompt): void;
}

export interface PromptStore {
  /**
   * Boot seeding. A missing entry is inserted from the shipped text; an untouched entry whose
   * shipped version changed is re-seeded so a release that improves a prompt actually lands; a
   * customised entry keeps its body and its seed version, and only learns what the new shipped
   * text is. Idempotent.
   */
  seed(shipped: readonly ShippedPrompt[]): void;
  /** The body an agent initialization resolves. Throws for an unknown id rather than guessing. */
  resolve(id: string): string;
  /** The stored skill as a Flue skill reference, rebuilt from the stored SKILL.md document. */
  resolveSkill(id: string, files?: Readonly<Record<string, string>>): SkillReference;
  entry(id: string): StoredPrompt;
  list(): readonly StoredPrompt[];
  /** Validate, then write. An invalid body is refused here, not at the next agent turn. */
  save(id: string, body: string): StoredPrompt;
  /** Put the current shipped text back and clear the customised mark. */
  revert(id: string): StoredPrompt;
}

/** The shipped version of a body: content-addressed, so "changed" needs no release metadata. */
export const promptVersion = (body: string): string => createHash("sha256").update(body).digest("hex").slice(0, 16);

interface SkillDocument {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly metadata?: Record<string, string>;
  readonly allowedTools?: string;
}

const FRONTMATTER = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/u;

/**
 * Parse a stored SKILL.md document. Frontmatter is loaded with js-yaml — the same failure the Flue
 * loader would raise at build time, raised here at save time instead. The message names the entry
 * and the problem and never quotes the body: a malformed document is refused, not echoed.
 */
const parseSkillDocument = (id: string, body: string): SkillDocument => {
  const match = FRONTMATTER.exec(body.replace(/^﻿/u, ""));
  if (match === null) throw new Error(`The ${id} skill body is missing its YAML frontmatter (--- name/description ---).`);
  let frontmatter: unknown;
  try {
    // FAILSAFE_SCHEMA is the schema Flue's own skill loader uses: every scalar stays a string, so
    // `name: yes` is the string "yes" rather than a boolean and `description: 2026-07-25` is not a
    // Date. Matching it exactly is what keeps "valid here" and "valid to Flue" the same predicate.
    frontmatter = load(match[1] ?? "", { schema: FAILSAFE_SCHEMA });
  } catch {
    throw new Error(`The ${id} skill body has invalid YAML frontmatter.`);
  }
  if (typeof frontmatter !== "object" || frontmatter === null || Array.isArray(frontmatter)) {
    throw new Error(`The ${id} skill body frontmatter must be a YAML mapping.`);
  }
  const raw = frontmatter as Record<string, unknown>;
  const text = (key: string): string | undefined => (typeof raw[key] === "string" ? (raw[key] as string) : undefined);
  const name = text("name");
  const description = text("description");
  if (name === undefined || description === undefined) {
    throw new Error(`The ${id} skill body frontmatter must declare a name and a description.`);
  }
  const metadata =
    raw.metadata === undefined || raw.metadata === null
      ? undefined
      : Object.fromEntries(Object.entries(raw.metadata as Record<string, unknown>).map(([key, value]) => [key, String(value)]));
  return {
    name,
    description,
    instructions: (match[2] ?? "").trim(),
    ...(text("license") === undefined ? {} : { license: text("license") as string }),
    ...(text("compatibility") === undefined ? {} : { compatibility: text("compatibility") as string }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(text("allowed-tools") === undefined ? {} : { allowedTools: text("allowed-tools") as string }),
  };
};

/**
 * Turn a stored SKILL.md document into the skill reference an agent mounts. `defineSkill` applies
 * the Agent Skills rules (name shape and length, description length, file shapes); a body that
 * fails them throws here — which, on the save path, is before anything is written.
 */
export const promptSkillReference = (
  id: string,
  body: string,
  files: Readonly<Record<string, string>> = {},
): SkillReference => {
  const document = parseSkillDocument(id, body);
  try {
    return defineSkill({ ...document, ...(Object.keys(files).length === 0 ? {} : { files }) });
  } catch (cause) {
    throw new Error(`The ${id} skill body is not a valid skill: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
};

/**
 * Refuse a body before it is written. Instructions carry no schema beyond "there is text here".
 *
 * The skill check deliberately validates the document ALONE, with no auxiliary `files`. That is safe
 * only because auxiliary files are shipped constants an operator cannot edit (`SKILL_FILES` in the
 * agents catalog): the document is the whole editable surface, so validating it is validating the
 * edit. The day auxiliary files become editable, this must take them too — otherwise a body could
 * pass `save` and fail at the next agent turn, which is exactly what this function exists to stop.
 */
export const validatePromptBody = (id: string, kind: PromptEntryKind, body: string): void => {
  if (kind === "skill") {
    promptSkillReference(id, body);
    return;
  }
  if (body.trim() === "") throw new Error(`The ${id} instructions must not be empty.`);
};

export const createPromptStore = (rows: PromptRows): PromptStore => {
  const entry = (id: string): StoredPrompt => {
    const row = rows.get(id);
    if (row === undefined) throw new Error(`There is no prompt store entry ${id}.`);
    return row;
  };
  const write = (row: StoredPrompt): StoredPrompt => {
    rows.put(row);
    return row;
  };
  return {
    seed: (shipped) => {
      const now = new Date().toISOString();
      for (const entryShipped of shipped) {
        const version = promptVersion(entryShipped.body);
        const existing = rows.get(entryShipped.id);
        const base = {
          id: entryShipped.id,
          kind: entryShipped.kind,
          shippedBody: entryShipped.body,
          shippedVersion: version,
        };
        // First boot, and every re-seed of an untouched entry: the shipped text IS the entry.
        if (existing === undefined || (!existing.customised && existing.seededVersion !== version)) {
          write({ ...base, body: entryShipped.body, customised: false, seededVersion: version, updatedAt: now });
          continue;
        }
        // A shipped entry that changed kind is a different entry wearing the same id. Keeping the
        // customised body would leave, say, a plain instruction string labelled `kind: "skill"` —
        // refused at the next agent initialization rather than at save time, the one place this
        // store otherwise never defers a failure. Re-seed it instead; the edit is not portable.
        if (existing.kind !== entryShipped.kind) {
          write({ ...base, body: entryShipped.body, customised: false, seededVersion: version, updatedAt: now });
          continue;
        }
        // A customised entry survives the upgrade untouched apart from learning what is now shipped;
        // its seededVersion stays put, so the divergence from `version` remains visible.
        if (existing.shippedVersion !== version) {
          write({ ...base, body: existing.body, customised: existing.customised, seededVersion: existing.seededVersion, updatedAt: now });
        }
      }
    },
    resolve: (id) => {
      const row = entry(id);
      // Re-validated on the way out, not only on the way in. `save` is not the only way a row can
      // change — a hand-edited database, a bad restore, or a future writer can all put a body here
      // that never passed validation, and an empty instruction block is invisible in a transcript.
      // The skill kind already gets this for free, because `resolveSkill` re-parses every time.
      validatePromptBody(id, row.kind, row.body);
      return row.body;
    },
    resolveSkill: (id, files) => {
      const row = entry(id);
      if (row.kind !== "skill") throw new Error(`The prompt store entry ${id} is not a skill.`);
      return promptSkillReference(id, row.body, files);
    },
    entry,
    list: () => rows.list(),
    save: (id, body) => {
      const existing = entry(id);
      // Validated before anything is written: a refused body never reaches the row an agent reads.
      validatePromptBody(id, existing.kind, body);
      return write({ ...existing, body, customised: true, updatedAt: new Date().toISOString() });
    },
    revert: (id) => {
      const existing = entry(id);
      return write({
        ...existing,
        body: existing.shippedBody,
        customised: false,
        seededVersion: existing.shippedVersion,
        updatedAt: new Date().toISOString(),
      });
    },
  };
};

/** An in-process row set. The default store, and what unit tests and the eval fixture run on. */
export const createMemoryPromptRows = (): PromptRows => {
  const rows = new Map<string, StoredPrompt>();
  return {
    get: (id) => rows.get(id),
    list: () => [...rows.values()].sort((left, right) => left.id.localeCompare(right.id)),
    put: (row) => {
      rows.set(row.id, row);
    },
  };
};

const storeSlot = createFlueGlobal<PromptStore>(
  "prompt-store",
  "The prompt store is not configured (the composition root must call configurePromptStore before any agent initializes).",
);

/**
 * There is exactly ONE way a prompt reaches an agent: through the store, and it must have been bound
 * deliberately. This throws when the slot is empty rather than manufacturing a fallback, because the
 * fallback's failure mode is invisible: agents would resolve shipped text from a private in-memory
 * copy while an operator's `prompt set` lands in the durable file, with nothing to distinguish that
 * from a working install. Every sibling singleton in this codebase fails closed the same way.
 *
 * A process with no composition root — a unit test, the eval fixture — binds one explicitly with
 * {@link configureEphemeralPromptStore}. That is a real store seeded from the same shipped catalog,
 * so "served from the store" stays literally true everywhere; what it is not is automatic.
 */
export const getPromptStore = (): PromptStore => storeSlot.get();

export const configurePromptStore = (store: PromptStore): void => storeSlot.set(store);

/**
 * Bind an in-memory store, for a process that has no durable data directory: the eval fixture and
 * the unit tests. Explicit by design — see {@link getPromptStore}.
 */
export const configureEphemeralPromptStore = (): PromptStore => {
  const store = createPromptStore(createMemoryPromptRows());
  configurePromptStore(store);
  return store;
};
