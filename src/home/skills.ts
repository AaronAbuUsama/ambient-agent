import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";

/**
 * Skills follow the ecosystem SKILL.md contract: a folder holding a SKILL.md
 * with `name` and `description` frontmatter and the skill body below it.
 * Exactly two scopes (home `skills/`, chat `chats/<slug>/skills/`); a chat
 * copy shadows the home copy by name. Broken skills are diagnosed loudly and
 * skipped in runs — same fail-closed grammar as mandates.
 */

const frontmatterSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]{1,64}$/, "name must be kebab-case (a-z, 0-9, dashes, max 64)"),
  description: z.string().min(1),
});

export interface ChatSkill {
  readonly name: string;
  readonly content: string;
  readonly scope: "home" | "chat";
}

export interface BrokenSkill {
  readonly scope: "home" | "chat";
  readonly folder: string;
  readonly problem: string;
}

export interface SkillScan {
  readonly skills: readonly ChatSkill[];
  readonly broken: readonly BrokenSkill[];
}

function readScope(directory: string, scope: "home" | "chat") {
  const skills: ChatSkill[] = [];
  const broken: BrokenSkill[] = [];
  if (!existsSync(directory)) return { skills, broken };
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const folder = entry.name;
    const path = join(directory, folder, "SKILL.md");
    if (!existsSync(path)) {
      broken.push({ scope, folder, problem: "SKILL.md is missing" });
      continue;
    }
    const raw = readFileSync(path, "utf8");
    const match = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
    if (!match || match[1] === undefined) {
      broken.push({ scope, folder, problem: "SKILL.md has no frontmatter block" });
      continue;
    }
    let frontmatter: unknown;
    try {
      frontmatter = YAML.parse(match[1]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      broken.push({ scope, folder, problem: `frontmatter is not valid YAML: ${message}` });
      continue;
    }
    const parsed = frontmatterSchema.safeParse(frontmatter);
    if (!parsed.success) {
      broken.push({ scope, folder, problem: `frontmatter: ${z.prettifyError(parsed.error)}` });
      continue;
    }
    const content = raw.slice(match[0].length).trim();
    if (content.length === 0) {
      broken.push({ scope, folder, problem: "SKILL.md has no body" });
      continue;
    }
    skills.push({ name: parsed.data.name, content, scope });
  }
  return { skills, broken };
}

/** The skills one chat's speaker receives: home scope shadowed by chat scope, by name. */
export function skillsForChat(home: string, slug: string | undefined): SkillScan {
  const homeScope = readScope(join(home, "skills"), "home");
  const chatScope =
    slug === undefined
      ? { skills: [], broken: [] }
      : readScope(join(home, "chats", slug, "skills"), "chat");
  const chatNames = new Set(chatScope.skills.map(({ name }) => name));
  return {
    skills: [...chatScope.skills, ...homeScope.skills.filter(({ name }) => !chatNames.has(name))],
    broken: [...homeScope.broken, ...chatScope.broken],
  };
}

/** Every skill everywhere, for doctor: home scope plus each chat folder's scope. */
export function scanAllSkills(home: string): SkillScan {
  const result = readScope(join(home, "skills"), "home");
  const skills = [...result.skills];
  const broken = [...result.broken];
  const chatsDirectory = join(home, "chats");
  if (existsSync(chatsDirectory)) {
    for (const entry of readdirSync(chatsDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const scope = readScope(join(chatsDirectory, entry.name, "skills"), "chat");
      skills.push(...scope.skills);
      broken.push(
        ...scope.broken.map((skill) => ({ ...skill, folder: `${entry.name}/${skill.folder}` })),
      );
    }
  }
  return { skills, broken };
}
