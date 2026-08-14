import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { z } from "zod";
import { createGitHubIssues, type GhCommand } from "../github/issues";
import type { AgentDefinition, ToolConfigCheck } from "../home/agents";
import type { AgentGrant } from "../home/mandates";

/**
 * The worker toolbox: tools are code, agents are data. Every tool a
 * definition may compose is registered here with its own configuration
 * schema, its narrowing rule, and its binding. The model's tool signature
 * never contains a destination axis — destinations are validated and bound
 * host-side before any model runs, the same invariant that stops a speaker
 * sending to an arbitrary chat.
 */
export interface WorkerToolbox {
  /** The definition scanner's judge: unknown tool or invalid fragment -> problem. */
  readonly check: ToolConfigCheck;
  /**
   * definition ∩ grant. A grant naming an unknown or uncomposed tool, or
   * allowing anything the definition does not, is a problem — a grant may
   * narrow the ceiling, never widen it, and misconfiguration is loud.
   */
  compose(
    definition: AgentDefinition,
    grant?: AgentGrant,
  ): ComposedAgent | { readonly problem: string };
}

export interface ComposedAgent {
  readonly definition: AgentDefinition;
  /**
   * The advertisement rendered into a delegating agent's context: the
   * definition's authored description plus capability lines derived from
   * code, so what is promised cannot drift from what the tools do.
   */
  readonly summary: string;
  /** Allowed assignment targets after narrowing; empty when no composed tool has a destination axis. */
  readonly targets: readonly string[];
  /**
   * Bind every composed tool to one assignment. Throws when the target
   * falls outside the effective constraint — a definition may have been
   * narrowed between the assignment's creation and its claim.
   */
  bind(binding: AssignmentBinding): readonly AgentTool[];
}

/** What a bound tool knows about the one assignment it serves. */
export interface AssignmentBinding {
  /** Also the idempotency key stamped into external effects. */
  readonly taskId: string;
  /** The destination chosen at assignment creation, host-validated; omitted only when exactly one candidate exists. */
  readonly target?: string | undefined;
  /**
   * Retain an external-effect receipt the moment the effect exists — at the
   * tool boundary, before the model even sees the result. The retained
   * receipt is the authority a retry consults, so the crash window between
   * effect and receipt stays as small as the code can make it.
   */
  readonly retainReceipt?: (receipt: {
    readonly kind: "text" | "file" | "url" | "json";
    readonly title: string;
    readonly value: string;
  }) => Promise<void>;
}

/**
 * One registered tool, facing the toolbox with `unknown` and re-validating
 * through its own schema inside every method — configuration crosses this
 * boundary as data, never as a trusted cast.
 */
interface ToolEntry {
  check(config: unknown): string | undefined;
  narrow(config: unknown, grantFragment: unknown): { config: unknown } | { problem: string };
  describe(config: unknown): string;
  targets(config: unknown): readonly string[];
  bind(config: unknown, binding: AssignmentBinding, gh: GhCommand | undefined): AgentTool;
}

const repositoryName = z.string().regex(/^[\w.-]+\/[\w.-]+$/, "expected an owner/name repository");

const githubIssuesConfig = z.strictObject({
  repositories: z.array(repositoryName).nonempty(),
});

const fileIssueParameters = Type.Object({
  title: Type.String({ minLength: 1, description: "Issue title." }),
  body: Type.String({ minLength: 1, description: "Complete issue body in Markdown." }),
});

function chooseTarget(allowed: readonly string[], binding: AssignmentBinding): string {
  if (binding.target !== undefined) {
    if (!allowed.includes(binding.target)) {
      throw new Error(
        `assignment target "${binding.target}" is outside this agent's allowed repositories`,
      );
    }
    return binding.target;
  }
  const only = allowed.length === 1 ? allowed[0] : undefined;
  if (only === undefined) {
    throw new Error("an assignment must name its target repository when more than one is allowed");
  }
  return only;
}

const githubIssues: ToolEntry = {
  check(config) {
    const result = githubIssuesConfig.safeParse(config);
    return result.success ? undefined : z.prettifyError(result.error);
  },
  narrow(config, grantFragment) {
    const base = githubIssuesConfig.parse(config);
    const grant = githubIssuesConfig.safeParse(grantFragment);
    if (!grant.success) return { problem: `grant: ${z.prettifyError(grant.error)}` };
    const ceiling = new Set<string>(base.repositories);
    const widened = grant.data.repositories.filter((repository) => !ceiling.has(repository));
    if (widened.length > 0) {
      return { problem: `grant allows ${widened.join(", ")} which the definition does not` };
    }
    return { config: { repositories: grant.data.repositories } };
  },
  describe(config) {
    return `files GitHub issues into: ${githubIssuesConfig.parse(config).repositories.join(", ")}`;
  },
  targets(config) {
    return githubIssuesConfig.parse(config).repositories;
  },
  bind(config, binding, gh) {
    const repository = chooseTarget(githubIssuesConfig.parse(config).repositories, binding);
    const issues = createGitHubIssues({ repository, ...(gh ? { gh } : {}) });
    // One issue per assignment: the objective is bounded, like send_message
    // being once per Conversation run.
    let used = false;
    const tool: AgentTool<typeof fileIssueParameters> = {
      name: "file_issue",
      label: "File issue",
      description: `File one GitHub issue in ${repository}. The repository is fixed for this assignment.`,
      parameters: fileIssueParameters,
      executionMode: "sequential",
      async execute(_toolCallId, { title, body }) {
        if (used) throw new Error("file_issue can only be called once per assignment");
        used = true;
        const filed = await issues.file({ key: binding.taskId, title, body });
        await binding.retainReceipt?.({ kind: "url", title: "issue", value: filed.url });
        const verb = filed.outcome === "adopted" ? "Adopted existing" : "Filed";
        return {
          content: [{ type: "text", text: `${verb} issue #${filed.number}: ${filed.url}` }],
          details: filed,
        };
      },
    };
    return tool;
  },
};

const entries: Readonly<Record<string, ToolEntry>> = {
  github_issues: githubIssues,
};

export function createWorkerToolbox(options: { readonly gh?: GhCommand } = {}): WorkerToolbox {
  return {
    check(toolName, config) {
      const entry = entries[toolName];
      if (!entry) return "unknown tool";
      return entry.check(config);
    },

    compose(definition, grant) {
      const problems: string[] = [];
      const effective = new Map<string, { entry: ToolEntry; config: unknown }>();
      for (const [toolName, config] of Object.entries(definition.tools)) {
        const entry = entries[toolName];
        if (!entry) {
          problems.push(`${toolName}: unknown tool`);
          continue;
        }
        const invalid = entry.check(config);
        if (invalid !== undefined) {
          problems.push(`${toolName}: ${invalid}`);
          continue;
        }
        const fragment = grant?.tools?.[toolName];
        if (fragment === undefined) {
          effective.set(toolName, { entry, config });
          continue;
        }
        const narrowed = entry.narrow(config, fragment);
        if ("problem" in narrowed) {
          problems.push(`${toolName}: ${narrowed.problem}`);
          continue;
        }
        effective.set(toolName, { entry, config: narrowed.config });
      }
      for (const toolName of Object.keys(grant?.tools ?? {})) {
        if (!(toolName in definition.tools)) {
          problems.push(`${toolName}: granted but not composed by this agent`);
        }
      }
      if (problems.length > 0) return { problem: problems.join("; ") };

      const bound = [...effective.values()];
      return {
        definition,
        summary: [
          definition.description,
          ...bound.map(({ entry, config }) => entry.describe(config)),
        ].join("\n"),
        targets: bound.flatMap(({ entry, config }) => entry.targets(config)),
        bind: (binding) =>
          bound.map(({ entry, config }) => entry.bind(config, binding, options.gh)),
      };
    },
  };
}
