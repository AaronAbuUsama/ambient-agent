import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  createIssueOperationStore,
  type IssueOperationKind,
} from "../../src/capabilities/issue-management/operation-store.ts";
import { createFakeIssueRepository } from "../../src/host/fake-issue-repository.ts";
import { commentProviderBody, issueOperationMarker, issueProviderBody } from "../../src/host/issue-operation-footer.ts";
import { createConversationArchive } from "../../src/intake/conversation-archive.ts";
import { conversationArrival } from "../../src/intake/conversation-event.ts";
import { createManagedChatAdmissionOperator, createManagedChatInbox } from "../../src/intake/managed-chat-inbox.ts";
import { createUncertainWorkController, inspectUncertainWorkStatus } from "../../src/managed/uncertain-work.ts";
import type { IncomingMessage } from "whatsappd";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = (): string => {
  const root = mkdtempSync(join(tmpdir(), "ambient-uncertain-work-"));
  roots.push(root);
  return join(root, "application.sqlite");
};

const message = (id: string, chatId = "managed@g.us"): IncomingMessage =>
  ({
    id,
    chatId,
    from: "15551112222@s.whatsapp.net",
    fromMe: false,
    timestamp: 1,
    live: true,
    isGroup: true,
    kind: "text",
    text: "private report content",
    reply: async () => ({ id: "reply", chatId: "managed@g.us", fromMe: true }),
  }) as IncomingMessage;

const seedUncertainAdmission = (path: string, windowId: string, attemptId: string, chatId = "managed@g.us"): void => {
  const archive = createConversationArchive(path);
  const inbox = createManagedChatInbox(archive, {
    allowed: () => true,
    createId: () => windowId,
    createAttemptId: () => attemptId,
  });
  inbox.recorder.append(conversationArrival(message(`message-${windowId}`, chatId)));
  const window = inbox.createWindow({ chatId, messages: inbox.unwindowed(), reason: "debounce" });
  const attempt = inbox.beginAdmission(window.id);
  inbox.markUncertain(window.id, attempt.attemptId, "private provider failure detail");
  archive.close();
};

const seedUncertainOperation = (
  operations: ReturnType<typeof createIssueOperationStore>,
  input: {
    readonly operationId: string;
    readonly kind: IssueOperationKind;
    readonly issueNumber?: number;
    readonly target?: Readonly<Record<string, unknown>>;
  },
): void => {
  operations.begin({
    ...input,
    repository: "acme/widgets",
    startedAt: "2026-07-15T01:00:00.000Z",
  });
  operations.uncertain(input.operationId, "private provider failure detail", "2026-07-15T01:01:00.000Z");
};

describe("Uncertain work operator boundary", () => {
  it("diagnoses every external mutation kind with reads only and separates attributable from observed success", async () => {
    const path = fixture();
    seedUncertainAdmission(path, "window-uncertain", "attempt-uncertain");
    const admissions = createManagedChatAdmissionOperator(path);
    const operations = createIssueOperationStore(path);
    const repository = createFakeIssueRepository();
    const ref = { owner: "acme", repo: "widgets" } as const;

    repository.seed({
      repository: ref,
      title: "Created issue",
      body: issueProviderBody("private issue body", [issueOperationMarker({ id: "create-issue" })]),
    });
    const updated = repository.seed({ repository: ref, title: "Observed update", body: "private updated body" });
    const discussion = repository.seed({ repository: ref, title: "Discussion", body: "private body" });
    repository.seedComment({
      repository: ref,
      number: discussion.number,
      body: commentProviderBody("private comment", [issueOperationMarker({ id: "create-comment" })]),
      author: "ambient-agent",
    });
    const editedComment = repository.seedComment({
      repository: ref,
      number: discussion.number,
      body: commentProviderBody("private edit", [issueOperationMarker({ id: "update-comment" })]),
      author: "ambient-agent",
    });
    repository.seedComment({
      repository: ref,
      number: discussion.number,
      body: commentProviderBody("different comment", [issueOperationMarker({ id: "update-comment" })]),
      author: "ambient-agent",
    });
    const stateIssue = repository.seed({ repository: ref, title: "State", body: "private body" });
    await repository.setState({
      repository: ref,
      number: stateIssue.number,
      state: "closed",
      reason: "completed",
      operation: { id: "seed-state" },
    });
    repository.resetEvents();

    seedUncertainOperation(operations, {
      operationId: "create-issue",
      kind: "create-issue",
      target: { kind: "bug", title: "Created issue", body: "private issue body" },
    });
    seedUncertainOperation(operations, {
      operationId: "update-issue",
      kind: "update-issue",
      issueNumber: updated.number,
      target: { title: "Observed update", body: "private updated body" },
    });
    seedUncertainOperation(operations, {
      operationId: "create-comment",
      kind: "create-comment",
      issueNumber: discussion.number,
      target: { body: "private comment" },
    });
    seedUncertainOperation(operations, {
      operationId: "update-comment",
      kind: "update-comment",
      issueNumber: discussion.number,
      target: { commentId: editedComment.id, body: "private edit" },
    });
    seedUncertainOperation(operations, {
      operationId: "delete-comment",
      kind: "delete-comment",
      issueNumber: discussion.number,
      target: { commentId: 999_999 },
    });
    seedUncertainOperation(operations, {
      operationId: "set-state",
      kind: "set-issue-state",
      issueNumber: stateIssue.number,
      target: { state: "closed", reason: "completed" },
    });

    const controller = createUncertainWorkController({
      admissions,
      operations,
      admissionEvidence: { find: async () => undefined },
      repository,
      now: () => new Date("2026-07-15T02:00:00.000Z"),
    });
    expect(controller.status()).toEqual({
      health: "degraded",
      admissions: 1,
      externalMutations: 6,
      total: 7,
      mutationKinds: {
        "create-issue": 1,
        "update-issue": 1,
        "create-comment": 1,
        "update-comment": 1,
        "delete-comment": 1,
        "set-issue-state": 1,
      },
    });

    const report = await controller.diagnose();
    expect(report.diagnoses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ref: "admission:window-uncertain", outcome: "unresolved" }),
        expect.objectContaining({
          ref: "mutation:create-issue",
          outcome: "reconciled",
          evidence: "operation-identity",
        }),
        expect.objectContaining({ ref: "mutation:update-issue", outcome: "observed", evidence: "desired-state-only" }),
        expect.objectContaining({
          ref: "mutation:create-comment",
          outcome: "reconciled",
          evidence: "operation-identity",
        }),
        expect.objectContaining({
          ref: "mutation:update-comment",
          outcome: "reconciled",
          evidence: "operation-identity",
        }),
        expect.objectContaining({
          ref: "mutation:delete-comment",
          outcome: "observed",
          evidence: "desired-state-only",
        }),
        expect.objectContaining({ ref: "mutation:set-state", outcome: "observed", evidence: "desired-state-only" }),
      ]),
    );
    expect(
      repository
        .events()
        .some((event) =>
          ["create", "update", "create-comment", "update-comment", "delete-comment", "set-issue-state"].includes(
            event.kind,
          ),
        ),
    ).toBe(false);
    expect(JSON.stringify(report)).not.toContain("private");
    expect(report.after).toMatchObject({ admissions: 1, externalMutations: 3, total: 4 });

    await expect(controller.acceptObserved("mutation:update-issue")).resolves.toMatchObject({ outcome: "accepted" });
    await expect(controller.acceptObserved("mutation:delete-comment")).resolves.toMatchObject({ outcome: "accepted" });
    await expect(controller.acceptObserved("mutation:set-state")).resolves.toMatchObject({ outcome: "accepted" });
    expect(controller.status()).toMatchObject({ admissions: 1, externalMutations: 0, total: 1 });
    controller.close();
  });

  it("requires an explicit retry, creates a replacement identity, and preserves the prior audit record", async () => {
    const path = fixture();
    seedUncertainAdmission(path, "window-retry", "attempt-before-retry");
    const admissions = createManagedChatAdmissionOperator(path);
    const operations = createIssueOperationStore(path);
    const repository = createFakeIssueRepository();
    const issue = repository.seed({ repository: { owner: "acme", repo: "widgets" }, title: "Issue", body: "Body" });
    seedUncertainOperation(operations, {
      operationId: "comment-before-retry",
      kind: "create-comment",
      issueNumber: issue.number,
      target: { body: "Retry this exact comment" },
    });
    const controller = createUncertainWorkController({
      admissions,
      operations,
      admissionEvidence: { find: async () => undefined },
      repository,
      createOperationId: () => "comment-after-retry",
      now: () => new Date("2026-07-15T03:00:00.000Z"),
    });

    await controller.diagnose();
    expect(repository.events().some((event) => event.kind === "create-comment")).toBe(false);
    await expect(controller.retry("mutation:comment-before-retry")).resolves.toEqual({
      ref: "mutation:comment-before-retry",
      outcome: "retried",
      replacementRef: "mutation:comment-after-retry",
    });
    expect(repository.events()).toContainEqual(
      expect.objectContaining({ kind: "create-comment", operationId: "comment-after-retry", outcome: "applied" }),
    );
    expect(operations.get("comment-before-retry")).toMatchObject({
      status: "abandoned",
      resolution: "retried",
      replacementOperationId: "comment-after-retry",
    });
    expect(operations.get("comment-after-retry")).toMatchObject({ status: "completed" });

    await expect(controller.retry("admission:window-retry")).resolves.toEqual({
      ref: "admission:window-retry",
      outcome: "retry-authorized",
    });
    expect(admissions.resolutions("window-retry")).toEqual([
      {
        windowId: "window-retry",
        attemptId: "attempt-before-retry",
        resolution: "retried",
        operatorReason: "Operator explicitly authorized retry",
        resolvedAt: "2026-07-15T03:00:00.000Z",
      },
    ]);
    expect(controller.status()).toMatchObject({ health: "healthy", total: 0 });
    controller.close();
  });

  it("reconciles an Uncertain admission only from a canonical Flue receipt", async () => {
    const path = fixture();
    seedUncertainAdmission(path, "window-reconciled", "attempt-reconciled");
    const admissions = createManagedChatAdmissionOperator(path);
    const operations = createIssueOperationStore(path);
    const controller = createUncertainWorkController({
      admissions,
      operations,
      admissionEvidence: {
        find: async (window) =>
          window.id === "window-reconciled"
            ? { dispatchId: "dispatch-canonical", acceptedAt: "2026-07-15T03:30:00.000Z" }
            : undefined,
      },
      repository: createFakeIssueRepository(),
      now: () => new Date("2026-07-15T03:31:00.000Z"),
    });

    await expect(controller.diagnose()).resolves.toMatchObject({
      diagnoses: [
        {
          ref: "admission:window-reconciled",
          category: "admission",
          outcome: "reconciled",
          evidence: "canonical-admission-receipt",
        },
      ],
      after: { health: "healthy", total: 0 },
    });
    expect(admissions.resolutions("window-reconciled")).toEqual([
      expect.objectContaining({
        attemptId: "attempt-reconciled",
        resolution: "reconciled",
        operatorReason: "Canonical Flue admission receipt observed",
      }),
    ]);
    controller.close();
  });

  it("abandons an unresolved admission without deleting its attempt audit", () => {
    const path = fixture();
    seedUncertainAdmission(path, "window-abandon", "attempt-abandon");
    const admissions = createManagedChatAdmissionOperator(path);
    const operations = createIssueOperationStore(path);
    seedUncertainOperation(operations, {
      operationId: "mutation-abandon",
      kind: "delete-comment",
      issueNumber: 1,
      target: { commentId: 9 },
    });
    const controller = createUncertainWorkController({
      admissions,
      operations,
      admissionEvidence: { find: async () => undefined },
      repository: createFakeIssueRepository(),
      now: () => new Date("2026-07-15T04:00:00.000Z"),
    });

    expect(controller.abandon("admission:window-abandon")).toMatchObject({ outcome: "abandoned" });
    expect(admissions.resolutions("window-abandon")).toEqual([
      expect.objectContaining({
        attemptId: "attempt-abandon",
        resolution: "abandoned",
        operatorReason: "Operator explicitly abandoned unresolved work",
      }),
    ]);
    expect(controller.abandon("mutation:mutation-abandon")).toMatchObject({ outcome: "abandoned" });
    expect(operations.get("mutation-abandon")).toMatchObject({
      status: "abandoned",
      resolution: "abandoned",
    });
    expect(controller.status()).toMatchObject({ health: "healthy", total: 0 });
    controller.close();
  });

  it("reports stopped in-flight work as degraded and promotes orphan mutations before diagnosis", async () => {
    const path = fixture();
    const archive = createConversationArchive(path);
    const inbox = createManagedChatInbox(archive, {
      allowed: () => true,
      createId: () => "dispatching-window",
      createAttemptId: () => "dispatching-attempt",
    });
    inbox.recorder.append(conversationArrival(message("dispatching-message")));
    const window = inbox.createWindow({ chatId: "managed@g.us", messages: inbox.unwindowed(), reason: "debounce" });
    inbox.beginAdmission(window.id);
    archive.close();

    const interrupted = createIssueOperationStore(path);
    interrupted.begin({
      operationId: "attempting-operation",
      kind: "create-issue",
      repository: "acme/widgets",
      target: { kind: "bug", title: "Interrupted", body: "Private body" },
      startedAt: "2026-07-15T05:00:00.000Z",
    });
    interrupted.close();

    expect(inspectUncertainWorkStatus(path)).toMatchObject({
      health: "degraded",
      admissions: 1,
      externalMutations: 1,
      total: 2,
    });

    const reopenedArchive = createConversationArchive(path);
    createManagedChatInbox(reopenedArchive, { allowed: () => false });
    reopenedArchive.close();
    const operations = createIssueOperationStore(path);
    expect(operations.get("attempting-operation")).toMatchObject({
      status: "uncertain",
      error: "Process restarted after the provider mutation began",
    });
    const repository = createFakeIssueRepository();
    const controller = createUncertainWorkController({
      admissions: createManagedChatAdmissionOperator(path),
      operations,
      admissionEvidence: { find: async () => undefined },
      repository,
    });
    await controller.diagnose();
    expect(repository.events().some((event) => event.kind === "create")).toBe(false);
    controller.close();
  });

  it("keeps a successful retry Uncertain when only local completion persistence fails", async () => {
    const path = fixture();
    seedUncertainAdmission(path, "window-settlement", "attempt-settlement");
    const admissions = createManagedChatAdmissionOperator(path);
    const persisted = createIssueOperationStore(path);
    const repository = createFakeIssueRepository();
    const issue = repository.seed({ repository: { owner: "acme", repo: "widgets" }, title: "Issue", body: "Body" });
    seedUncertainOperation(persisted, {
      operationId: "comment-before-settlement-failure",
      kind: "create-comment",
      issueNumber: issue.number,
      target: { body: "Provider accepts this" },
    });
    const operations = {
      ...persisted,
      complete: () => {
        throw new Error("injected local completion failure");
      },
    };
    const controller = createUncertainWorkController({
      admissions,
      operations,
      admissionEvidence: { find: async () => undefined },
      repository,
      createOperationId: () => "comment-after-settlement-failure",
      now: () => new Date("2026-07-15T06:00:00.000Z"),
    });

    await expect(controller.retry("mutation:comment-before-settlement-failure")).resolves.toMatchObject({
      outcome: "uncertain",
      replacementRef: "mutation:comment-after-settlement-failure",
    });
    expect(repository.events()).toContainEqual(
      expect.objectContaining({
        kind: "create-comment",
        operationId: "comment-after-settlement-failure",
        outcome: "applied",
      }),
    );
    expect(persisted.get("comment-after-settlement-failure")).toMatchObject({
      status: "uncertain",
      error: expect.stringContaining("completion could not be persisted"),
    });
    controller.close();
  });

  it("retries a validated empty issue body and rotates bounded diagnosis fairly", async () => {
    const path = fixture();
    for (let index = 0; index < 30; index += 1) {
      seedUncertainAdmission(path, `window-fair-${index}`, `attempt-fair-${index}`, `chat-fair-${index}@g.us`);
    }
    const admissions = createManagedChatAdmissionOperator(path);
    const operations = createIssueOperationStore(path);
    const repository = createFakeIssueRepository();
    const issue = repository.seed({ repository: { owner: "acme", repo: "widgets" }, title: "Clear body", body: "Old" });
    seedUncertainOperation(operations, {
      operationId: "clear-body",
      kind: "update-issue",
      issueNumber: issue.number,
      target: { body: "" },
    });
    const controller = createUncertainWorkController({
      admissions,
      operations,
      admissionEvidence: { find: async () => undefined },
      repository,
      createOperationId: () => "clear-body-retry",
      now: () => new Date("2026-07-15T07:00:00.000Z"),
    });

    const first = await controller.diagnose();
    expect(first.examined).toBe(25);
    expect(first.deferred).toBe(6);
    expect(first.diagnoses).toContainEqual(expect.objectContaining({ ref: "mutation:clear-body" }));
    const firstAdmissions = new Set(
      first.diagnoses.filter((item) => item.category === "admission").map((item) => item.ref),
    );
    const second = await controller.diagnose();
    expect(second.diagnoses.some((item) => item.category === "admission" && !firstAdmissions.has(item.ref))).toBe(true);

    await expect(controller.retry("mutation:clear-body")).resolves.toMatchObject({ outcome: "retried" });
    await expect(
      repository.get({ repository: { owner: "acme", repo: "widgets" }, number: issue.number }),
    ).resolves.toMatchObject({ body: "" });
    controller.close();
  });
});
