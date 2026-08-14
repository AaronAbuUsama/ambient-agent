import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";

/**
 * Agent definitions: the composition surface for delegated work. Tools are
 * code; agents are data. One folder per definition under `agents/`, one
 * `agent.yaml` composing instructions with tools the registry provides. The
 * definition is both the advertisement (its description reaches the
 * speaker's context) and the constraint ceiling — a chat's grant may narrow
 * it, never widen it.
 */
export const agentDefinitionSchema = z.strictObject({
  description: z.string().min(1),
  /** A model ROLE name from the application configuration, never a provider. */
  model: z.string().min(1),
  instructions: z.string().min(1),
  tools: z.record(z.string().min(1), z.unknown()),
});

export interface AgentDefinition {
  readonly name: string;
  readonly description: string;
  readonly model: string;
  readonly instructions: string;
  /** Tool name -> that tool's validated configuration fragment. */
  readonly tools: Readonly<Record<string, unknown>>;
  /**
   * Content hash of the file that produced this definition. Runs are stamped
   * with it as evidence of what actually executed — definitions may change
   * on disk between an assignment's creation and its claim.
   */
  readonly contentHash: string;
}

export interface BrokenAgent {
  readonly name: string;
  readonly problem: string;
}

export interface AgentScan {
  readonly agents: readonly AgentDefinition[];
  readonly broken: readonly BrokenAgent[];
}

/**
 * The registry's judgment on one tool's configuration fragment: a problem to
 * report, or undefined when the fragment is valid. An unknown tool name is a
 * problem too — a definition may only compose tools that exist in code.
 */
export interface ToolConfigCheck {
  (toolName: string, config: unknown): string | undefined;
}

const namePattern = /^[a-z0-9-]{1,64}$/;

/**
 * Read every agent folder and split it into definitions and broken agents.
 * Fail-closed, the mandate pattern: unparseable YAML, schema violation, bad
 * folder name, an unknown tool, or invalid tool configuration makes the
 * agent broken — absent from composition and loud in doctor, never
 * half-loaded. A definition with no tools is legal only when it is not:
 * delegated work exists to cause effects, so an empty tools map is treated
 * as an authoring mistake.
 */
export function scanAgents(home: string, checkToolConfig: ToolConfigCheck): AgentScan {
  const agentsDirectory = join(home, "agents");
  if (!existsSync(agentsDirectory)) return { agents: [], broken: [] };

  const agents: AgentDefinition[] = [];
  const broken: BrokenAgent[] = [];
  const folders = readdirSync(agentsDirectory, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory(),
  );
  for (const folder of folders) {
    const name = folder.name;
    if (!namePattern.test(name)) {
      broken.push({ name, problem: "folder name is not a valid slug (a-z, 0-9, dashes, max 64)" });
      continue;
    }
    const path = join(agentsDirectory, name, "agent.yaml");
    if (!existsSync(path)) {
      broken.push({ name, problem: "agent.yaml is missing" });
      continue;
    }
    const raw = readFileSync(path, "utf8");
    let parsed: unknown;
    try {
      parsed = YAML.parse(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      broken.push({ name, problem: `agent.yaml is not valid YAML: ${message}` });
      continue;
    }
    const result = agentDefinitionSchema.safeParse(parsed);
    if (!result.success) {
      broken.push({ name, problem: `agent.yaml: ${z.prettifyError(result.error)}` });
      continue;
    }
    const toolNames = Object.keys(result.data.tools);
    if (toolNames.length === 0) {
      broken.push({ name, problem: "agent.yaml: an agent must compose at least one tool" });
      continue;
    }
    const problems = toolNames.flatMap((toolName) => {
      const problem = checkToolConfig(toolName, result.data.tools[toolName]);
      return problem === undefined ? [] : [`${toolName}: ${problem}`];
    });
    if (problems.length > 0) {
      broken.push({ name, problem: `agent.yaml tools: ${problems.join("; ")}` });
      continue;
    }
    agents.push({
      name,
      ...result.data,
      contentHash: createHash("sha256").update(raw).digest("hex").slice(0, 16),
    });
  }
  return { agents, broken };
}
