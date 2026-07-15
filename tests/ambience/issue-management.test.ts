import { stat } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";
import * as v from "valibot";

import ambience from "../../src/agents/ambience.ts";
import {
  configureIssueManagementRuntime,
  createIssueManagementPolicy,
  loadIssueManagementSettings,
} from "../../src/capabilities/issue-management/runtime.ts";
import { isUncertainIssueMutationError } from "../../src/capabilities/issue-management/issue-repository.ts";
import { createIssueManagementTools } from "../../src/capabilities/issue-management/tools.ts";
import { createIssueOperationStore } from "../../src/capabilities/issue-management/operation-store.ts";
import { createFakeIssueRepository } from "../../src/host/fake-issue-repository.ts";
import { githubIssueSearchQuery } from "../../src/host/github-issue-repository.ts";

const CHAT = "issue-management@g.us";
const REPOSITORY = { owner: "acme", repo: "widgets" } as const;

const configured = () => {
  const repository = createFakeIssueRepository();
  const operations = createIssueOperationStore(":memory:");
  const policy = createIssueManagementPolicy("acme/widgets", ["acme/widgets"]);
  configureIssueManagementRuntime({ repository, operations, policy });
  return { repository, operations, policy };
};

describe("Issue Management configuration", () => {
  it("loads only the managed GitHub boundary and fails closed when it is incomplete", () => {
    expect(
      loadIssueManagementSettings({
        GITHUB_TOKEN: "  github-token  ",
        GITHUB_REPO: " acme/widgets ",
        GITHUB_ALLOWED_REPOS: "acme/widgets,acme/other",
        GITHUB_ISSUE_OPERATIONS_DB_PATH: "/managed/application.sqlite",
      }),
    ).toEqual({
      token: "github-token",
      defaultRepository: "acme/widgets",
      allowedRepositories: ["acme/widgets", "acme/other"],
      operationDatabasePath: "/managed/application.sqlite",
    });
    expect(() =>
      loadIssueManagementSettings({
        GITHUB_REPO: "acme/widgets",
        GITHUB_ISSUE_OPERATIONS_DB_PATH: "/managed/application.sqlite",
      }),
    ).toThrow("GITHUB_TOKEN");
    expect(() => loadIssueManagementSettings({ GITHUB_TOKEN: "token", GITHUB_REPO: "acme/widgets" })).toThrow(
      "GITHUB_ISSUE_OPERATIONS_DB_PATH",
    );
  });

  it("rejects an out-of-policy repository before provider reads or writes", async () => {
    const { repository, operations, policy } = configured();
    const create = createIssueManagementTools({ repository, operations, policy }).find(
      (tool) => tool.name === "github_create_issue",
    )!;

    await expect(
      create.run({
        input: {
          repository: "other/repo",
          kind: "bug",
          title: "The scheduler loses a queued job",
          body: "Expected the queued job to run. It disappears after restart.",
        },
      }),
    ).rejects.toThrow("not in the configured GitHub write allowlist");
    expect(repository.events()).toEqual([]);
    expect(operations.list()).toEqual([]);
  });
});

describe("production Issue Management tools", () => {
  it("quotes model search text so GitHub qualifiers cannot escape the authorized repository", () => {
    expect(githubIssueSearchQuery(REPOSITORY, 'scheduler repo:other/private "secret"')).toBe(
      '"scheduler repo:other/private \\"secret\\"" in:title,body repo:acme/widgets is:issue',
    );
  });

  it("bounds a maximum-length issue title to GitHub's complete search-query limit", () => {
    const query = githubIssueSearchQuery(REPOSITORY, `${"x".repeat(250)}\\"repo:other/private`);
    expect(query.length).toBeLessThanOrEqual(256);
    expect(query).toMatch(/^"x+" in:title,body repo:acme\/widgets is:issue$/);
  });

  it("treats ambiguous HTTP responses as uncertain while preserving definite validation failures", () => {
    expect(isUncertainIssueMutationError(Object.assign(new Error("bad gateway"), { status: 502 }))).toBe(true);
    expect(isUncertainIssueMutationError(Object.assign(new Error("request timeout"), { status: 408 }))).toBe(true);
    expect(isUncertainIssueMutationError(Object.assign(new Error("validation failed"), { status: 422 }))).toBe(false);
  });

  it("searches for duplicates before creating one well-formed issue", async () => {
    const { repository, operations, policy } = configured();
    const create = createIssueManagementTools({
      repository,
      operations,
      policy,
      createOperationId: () => "operation-create-1",
      now: () => new Date("2026-07-15T00:00:00.000Z"),
    }).find((tool) => tool.name === "github_create_issue")!;

    await expect(
      create.run({
        input: {
          kind: "bug",
          title: "The scheduler loses a queued job",
          body: "Expected the queued job to run. It disappears after restart.",
        },
      }),
    ).resolves.toMatchObject({
      status: "created",
      operationId: "operation-create-1",
      issue: {
        number: 1,
        title: "The scheduler loses a queued job",
        state: "open",
      },
    });
    expect(repository.events()).toEqual([
      {
        kind: "search",
        repository: "acme/widgets",
        query: "The scheduler loses a queued job",
        matches: [],
      },
      {
        kind: "create",
        repository: "acme/widgets",
        operationId: "operation-create-1",
        outcome: "created",
        number: 1,
      },
    ]);
    expect(operations.list()).toEqual([
      expect.objectContaining({
        operationId: "operation-create-1",
        kind: "create-issue",
        repository: "acme/widgets",
        status: "completed",
        issueNumber: 1,
      }),
    ]);
  });

  it("persists the attempting Operation Identity before the provider mutation begins", async () => {
    const baseRepository = createFakeIssueRepository();
    const operations = createIssueOperationStore(":memory:");
    const repository = {
      ...baseRepository,
      create: async (input: Parameters<typeof baseRepository.create>[0]) => {
        expect(operations.get(input.operation.id)).toMatchObject({
          status: "attempting",
          repository: "acme/widgets",
        });
        return await baseRepository.create(input);
      },
    };
    const create = createIssueManagementTools({
      repository,
      operations,
      policy: createIssueManagementPolicy("acme/widgets", ["acme/widgets"]),
      createOperationId: () => "operation-before-provider",
    }).find((tool) => tool.name === "github_create_issue")!;

    await expect(
      create.run({
        input: {
          kind: "feature",
          title: "Show queue depth",
          body: "Operators need queue depth in status.",
        },
      }),
    ).resolves.toMatchObject({ status: "created", operationId: "operation-before-provider" });
  });

  it("returns the related issue and performs no create when duplicate search matches", async () => {
    const { repository, operations, policy } = configured();
    repository.seed({
      repository: REPOSITORY,
      title: "The scheduler loses a queued job",
      body: "Already tracked.",
    });
    repository.resetEvents();
    const create = createIssueManagementTools({ repository, operations, policy }).find(
      (tool) => tool.name === "github_create_issue",
    )!;

    await expect(
      create.run({
        input: {
          kind: "bug",
          title: "The scheduler loses a queued job",
          body: "Expected the queued job to run.",
        },
      }),
    ).resolves.toMatchObject({ status: "duplicate", issues: [{ number: 1 }] });
    expect(repository.events().map((event) => event.kind)).toEqual(["search"]);
    expect(operations.list()).toEqual([]);
  });

  it("allows a related but distinctly titled issue to proceed after the mandatory search", async () => {
    const { repository, operations, policy } = configured();
    repository.seed({
      repository: REPOSITORY,
      title: "Scheduler loses jobs during shutdown",
      body: "Related context: The scheduler loses a queued job under a different shutdown condition.",
    });
    repository.resetEvents();
    const create = createIssueManagementTools({
      repository,
      operations,
      policy,
      createOperationId: () => "operation-related-distinct",
    }).find((tool) => tool.name === "github_create_issue")!;

    await expect(
      create.run({
        input: {
          kind: "bug",
          title: "The scheduler loses a queued job",
          body: "This distinct case occurs only after restart.",
        },
      }),
    ).resolves.toMatchObject({ status: "created", issue: { number: 2 } });
    expect(repository.events().map((event) => event.kind)).toEqual(["search", "create"]);
  });

  it("reconciles an uncertain create by Operation Identity without a second mutation", async () => {
    const { repository, operations, policy } = configured();
    repository.timeoutNextCreate({ afterMutation: true });
    const create = createIssueManagementTools({
      repository,
      operations,
      policy,
      createOperationId: () => "operation-reconcile-1",
      now: () => new Date("2026-07-15T00:00:00.000Z"),
    }).find((tool) => tool.name === "github_create_issue")!;

    await expect(
      create.run({
        input: {
          kind: "feature",
          title: "Expose queue depth in status",
          body: "Operators need queue depth to diagnose backpressure.",
        },
      }),
    ).resolves.toMatchObject({
      status: "reconciled",
      operationId: "operation-reconcile-1",
      issue: { number: 1 },
    });
    expect(repository.events().filter((event) => event.kind === "create")).toHaveLength(1);
    expect(repository.events().filter((event) => event.kind === "find-operation")).toHaveLength(1);
    expect(operations.get("operation-reconcile-1")).toMatchObject({ status: "completed", issueNumber: 1 });
  });

  it("returns durable Uncertain state when observation proves nothing and never retries create", async () => {
    const { repository, operations, policy } = configured();
    repository.timeoutNextCreate({ afterMutation: false });
    const create = createIssueManagementTools({
      repository,
      operations,
      policy,
      createOperationId: () => "operation-uncertain-1",
      now: () => new Date("2026-07-15T00:00:00.000Z"),
    }).find((tool) => tool.name === "github_create_issue")!;

    await expect(
      create.run({
        input: {
          kind: "bug",
          title: "The queue stalls",
          body: "The queue remains pending after admission.",
        },
      }),
    ).resolves.toMatchObject({ status: "uncertain", operationId: "operation-uncertain-1" });
    expect(repository.events().filter((event) => event.kind === "create")).toHaveLength(1);
    expect(repository.events().filter((event) => event.kind === "find-operation")).toHaveLength(1);
    expect(operations.get("operation-uncertain-1")).toMatchObject({ status: "uncertain" });
  });

  it("never records a successful provider create as failed when completion persistence fails", async () => {
    const repository = createFakeIssueRepository();
    const persisted = createIssueOperationStore(":memory:");
    const operations = {
      ...persisted,
      complete: () => {
        throw new Error("injected SQLite completion failure");
      },
    };
    const create = createIssueManagementTools({
      repository,
      operations,
      policy: createIssueManagementPolicy("acme/widgets", ["acme/widgets"]),
      createOperationId: () => "operation-ledger-failure",
    }).find((tool) => tool.name === "github_create_issue")!;

    await expect(
      create.run({
        input: {
          kind: "feature",
          title: "Show queue health",
          body: "Operators need a queue health signal.",
        },
      }),
    ).resolves.toMatchObject({
      status: "uncertain",
      operationId: "operation-ledger-failure",
      issue: { number: 1 },
    });
    expect(repository.events().filter((event) => event.kind === "create")).toHaveLength(1);
    expect(persisted.get("operation-ledger-failure")).toMatchObject({ status: "uncertain" });
  });

  it("registers the Skill and only direct search, read, and create tools without model-controlled Operation Identity", async () => {
    configured();
    const config = await ambience.initialize({ id: CHAT, env: {} });
    expect(config.skills?.map((skill) => skill.name)).toEqual(["whatsapp-participation", "issue-management"]);
    expect(config.tools?.map((tool) => tool.name)).toEqual([
      "say",
      "whatsapp_read_thread",
      "whatsapp_search",
      "github_search_issues",
      "github_read_issue",
      "github_create_issue",
    ]);
    const create = config.tools?.find((tool) => tool.name === "github_create_issue");
    expect(create).toBeDefined();
    if (create === undefined) throw new Error("Expected the Issue Management create Tool");
    expect(
      v.parse(create.input as v.GenericSchema, {
        operationId: "model-injected",
        title: "x",
        body: "y",
        kind: "bug",
      }),
    ).not.toHaveProperty("operationId");
    expect(JSON.stringify(create.input)).not.toContain("operationId");
  });

  it("deletes the discarded proof workflow and provider path", async () => {
    for (const obsolete of [
      "src/github/proof-contract.ts",
      "src/github/proof-operation.ts",
      "src/github/proof-runtime.ts",
      "src/host/github-proof-host.ts",
      "src/host/fake-github-proof-host.ts",
      "src/tools/workflows/start-github-proof.ts",
      "src/workflows/github-proof.ts",
      "tests/fixtures/ambience/src/workflows/github-proof.ts",
      "tests/ambience/github-proof.test.ts",
    ]) {
      await expect(stat(join(process.cwd(), obsolete))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});
