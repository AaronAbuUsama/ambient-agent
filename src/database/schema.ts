import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

export const observations = sqliteTable(
  "observations",
  {
    id: text().primaryKey(),
    source: text({ enum: ["whatsapp", "worker"] }).notNull(),
    accountId: text("account_id").notNull(),
    nativeId: text("native_id").notNull(),
    conversationId: text("conversation_id"),
    occurredAt: text("occurred_at").notNull(),
    kind: text({
      enum: ["message", "task_request", "worker_result", "conversation_report"],
    }).notNull(),
    payload: text("payload_json", { mode: "json" }).notNull().$type<unknown>(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("observations_source", sql`${table.source} IN ('whatsapp', 'worker')`),
    check(
      "observations_kind",
      sql`${table.kind} IN ('message', 'task_request', 'worker_result', 'conversation_report')`,
    ),
    unique("observations_native_identity").on(table.source, table.accountId, table.nativeId),
    index("observations_conversation_occurred").on(
      table.conversationId,
      table.occurredAt,
      table.id,
    ),
  ],
);

export const whatsappIngestionCursors = sqliteTable(
  "whatsapp_ingestion_cursors",
  {
    accountId: text("account_id").primaryKey(),
    afterSeq: integer("after_seq").notNull(),
    state: text({ enum: ["bootstrapping", "active"] }).notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("whatsapp_ingestion_cursors_nonnegative", sql`${table.afterSeq} >= 0`),
    check("whatsapp_ingestion_cursors_state", sql`${table.state} IN ('bootstrapping', 'active')`),
  ],
);

export const agentRuns = sqliteTable(
  "agent_runs",
  {
    id: text().primaryKey(),
    agentId: text("agent_id").notNull(),
    role: text({ enum: ["conversation", "worker", "memory", "evaluator"] }).notNull(),
    conversationId: text("conversation_id"),
    taskId: text("task_id"),
    status: text({ enum: ["running", "succeeded", "failed"] }).notNull(),
    provider: text().notNull(),
    model: text().notNull(),
    thinking: text({ enum: ["off", "low", "medium", "high"] }).notNull(),
    maxOutputTokens: integer("max_output_tokens").notNull(),
    promptVersion: text("prompt_version").notNull(),
    input: text("input_json", { mode: "json" }).notNull().$type<unknown>(),
    result: text("result_json", { mode: "json" }).$type<unknown>(),
    error: text(),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check(
      "agent_runs_role",
      sql`${table.role} IN ('conversation', 'worker', 'memory', 'evaluator')`,
    ),
    check("agent_runs_thinking", sql`${table.thinking} IN ('off', 'low', 'medium', 'high')`),
    check("agent_runs_positive_max_tokens", sql`${table.maxOutputTokens} > 0`),
    check(
      "agent_runs_terminal_completion",
      sql`(${table.status} = 'running' AND ${table.completedAt} IS NULL)
        OR (${table.status} IN ('succeeded', 'failed') AND ${table.completedAt} IS NOT NULL)`,
    ),
    index("agent_runs_conversation_started").on(table.conversationId, table.startedAt, table.id),
    index("agent_runs_task_started").on(table.taskId, table.startedAt, table.id),
  ],
);

export const toolCalls = sqliteTable(
  "tool_calls",
  {
    id: text().primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    callId: text("call_id").notNull(),
    toolName: text("tool_name").notNull(),
    input: text("input_json", { mode: "json" }).notNull().$type<unknown>(),
    outcome: text({ enum: ["running", "succeeded", "failed"] }).notNull(),
    output: text("output_json", { mode: "json" }).$type<unknown>(),
    error: text(),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [
    unique("tool_calls_run_call").on(table.runId, table.callId),
    check(
      "tool_calls_terminal_completion",
      sql`(${table.outcome} = 'running' AND ${table.completedAt} IS NULL)
        OR (${table.outcome} IN ('succeeded', 'failed') AND ${table.completedAt} IS NOT NULL)`,
    ),
  ],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text().primaryKey(),
    conversationId: text("conversation_id").notNull(),
    requestedByRunId: text("requested_by_run_id")
      .notNull()
      .references(() => agentRuns.id),
    objective: text().notNull(),
    instructions: text(),
    workerProfile: text("worker_profile").notNull(),
    /** The destination chosen at creation (e.g. an owner/name repository); never the model's to choose. */
    target: text(),
    /**
     * Media refs the delegating speaker attached as evidence, validated against
     * its own conversation at creation. The worker carries them into the effect
     * it causes; it never chooses which evidence to reach for.
     */
    attachments: text({ mode: "json" }).$type<readonly string[]>(),
    status: text({
      enum: ["queued", "running", "succeeded", "failed", "cancelled"],
    }).notNull(),
    leaseOwner: text("lease_owner"),
    leaseUntil: text("lease_until"),
    resultSummary: text("result_summary"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
  },
  (table) => [
    check(
      "tasks_lifecycle",
      sql`(${table.status} = 'queued' AND ${table.startedAt} IS NULL AND ${table.completedAt} IS NULL)
        OR (${table.status} = 'running' AND ${table.startedAt} IS NOT NULL AND ${table.completedAt} IS NULL)
        OR (${table.status} IN ('succeeded', 'failed', 'cancelled') AND ${table.completedAt} IS NOT NULL)`,
    ),
    check(
      "tasks_active_lease",
      sql`(${table.status} = 'running' AND ${table.leaseOwner} IS NOT NULL AND ${table.leaseUntil} IS NOT NULL)
        OR (${table.status} != 'running' AND ${table.leaseOwner} IS NULL AND ${table.leaseUntil} IS NULL)`,
    ),
    index("tasks_conversation_updated").on(table.conversationId, table.updatedAt, table.id),
    index("tasks_queued")
      .on(table.createdAt, table.id)
      .where(sql`${table.status} = 'queued'`),
    index("tasks_expired_lease")
      .on(table.leaseUntil, table.id)
      .where(sql`${table.status} = 'running'`),
  ],
);

export const taskUpdates = sqliteTable(
  "task_updates",
  {
    id: text().primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    status: text({
      enum: ["queued", "running", "succeeded", "failed", "cancelled"],
    }).notNull(),
    summary: text(),
    occurredAt: text("occurred_at").notNull(),
  },
  (table) => [
    check(
      "task_updates_status",
      sql`${table.status} IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')`,
    ),
    index("task_updates_task").on(table.taskId, table.occurredAt, table.id),
  ],
);

export const taskWorkerAttempts = sqliteTable(
  "task_worker_attempts",
  {
    id: text().primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id),
    attempt: integer().notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("task_worker_attempts_positive", sql`${table.attempt} > 0`),
    unique("task_worker_attempts_task_attempt").on(table.taskId, table.attempt),
    unique("task_worker_attempts_run").on(table.runId),
  ],
);

export const taskArtifacts = sqliteTable(
  "task_artifacts",
  {
    id: text().primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    kind: text({ enum: ["text", "file", "url", "json"] }).notNull(),
    title: text().notNull(),
    value: text().notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [check("task_artifacts_kind", sql`${table.kind} IN ('text', 'file', 'url', 'json')`)],
);

/**
 * An agent's own intention, held across runs.
 *
 * Deliberately NOT `tasks`: an assignment is a bounded objective delegated to
 * a worker, while a to-do is something this agent means to do itself — ask a
 * question, check back on an answer, follow up when a build ships. A run that
 * decides to ask something and then forgets it by the next run is the failure
 * this exists to prevent.
 */
export const agentTodos = sqliteTable(
  "agent_todos",
  {
    id: text().primaryKey(),
    /** The chat this intention belongs to; an agent's memory is situated. */
    conversationId: text("conversation_id").notNull(),
    note: text().notNull(),
    status: text({ enum: ["open", "done", "dropped"] }).notNull(),
    createdAt: text("created_at").notNull(),
    /** Set when it left `open`, whichever way it went. */
    settledAt: text("settled_at"),
    /** Why it was dropped, when it was — a silent disappearance is a lie. */
    outcome: text(),
  },
  (table) => [
    check("agent_todos_status", sql`${table.status} IN ('open', 'done', 'dropped')`),
    index("agent_todos_conversation").on(table.conversationId, table.status),
  ],
);

/**
 * What one piece of media shows, written once and read by every role.
 *
 * Keyed by the media store's content hash, so the same image forwarded into
 * ten chats is interpreted once and never again. A row is evidence: it records
 * the model that produced it, and `failed` is retained too so a blob that
 * cannot be read is not retried forever.
 */
export const mediaDescriptions = sqliteTable(
  "media_descriptions",
  {
    ref: text().primaryKey(),
    status: text({ enum: ["described", "failed"] }).notNull(),
    mimetype: text(),
    description: text(),
    failureReason: text("failure_reason"),
    model: text().notNull(),
    promptVersion: text("prompt_version").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("media_descriptions_status", sql`${table.status} IN ('described', 'failed')`),
    check(
      "media_descriptions_described_has_text",
      sql`(${table.status} <> 'described') OR (${table.description} IS NOT NULL)`,
    ),
  ],
);

export const conversationInbox = sqliteTable(
  "conversation_inbox",
  {
    id: text().primaryKey(),
    conversationId: text("conversation_id").notNull(),
    kind: text({ enum: ["message", "task_update"] }).notNull(),
    referenceId: text("reference_id").notNull(),
    createdAt: text("created_at").notNull(),
    claimedByRunId: text("claimed_by_run_id").references(() => agentRuns.id),
    consumedByRunId: text("consumed_by_run_id").references(() => agentRuns.id),
    consumedAt: text("consumed_at"),
  },
  (table) => [
    check("conversation_inbox_kind", sql`${table.kind} IN ('message', 'task_update')`),
    unique("conversation_inbox_reference").on(table.kind, table.referenceId),
    check(
      "conversation_inbox_consumption",
      sql`(${table.consumedByRunId} IS NULL AND ${table.consumedAt} IS NULL)
        OR (${table.consumedByRunId} IS NOT NULL AND ${table.consumedAt} IS NOT NULL)`,
    ),
    index("conversation_inbox_pending")
      .on(table.conversationId, table.createdAt, table.id)
      .where(sql`${table.consumedByRunId} IS NULL`),
    index("conversation_inbox_claimed")
      .on(table.claimedByRunId)
      .where(sql`${table.claimedByRunId} IS NOT NULL AND ${table.consumedByRunId} IS NULL`),
  ],
);

export const conversationSpeakers = sqliteTable(
  "conversation_speakers",
  {
    conversationId: text("conversation_id").primaryKey(),
    mode: text({ enum: ["listening", "responding"] }).notNull(),
    instructions: text(),
    memoryBrief: text("memory_brief"),
    attendFrom: text("attend_from").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("conversation_speakers_mode", sql`${table.mode} IN ('listening', 'responding')`),
  ],
);

export const conversationSchedule = sqliteTable(
  "conversation_schedule",
  {
    conversationId: text("conversation_id").primaryKey(),
    firstPendingAt: text("first_pending_at"),
    latestPendingAt: text("latest_pending_at"),
    dueAt: text("due_at"),
    leaseOwner: text("lease_owner"),
    leaseUntil: text("lease_until"),
    activeRunId: text("active_run_id").references(() => agentRuns.id),
  },
  (table) => [
    check(
      "conversation_schedule_lease",
      sql`(${table.leaseOwner} IS NULL AND ${table.leaseUntil} IS NULL AND ${table.activeRunId} IS NULL)
        OR (${table.leaseOwner} IS NOT NULL AND ${table.leaseUntil} IS NOT NULL AND ${table.activeRunId} IS NOT NULL)`,
    ),
    index("conversation_schedule_due")
      .on(table.dueAt, table.conversationId)
      .where(sql`${table.activeRunId} IS NULL AND ${table.dueAt} IS NOT NULL`),
    index("conversation_schedule_expired")
      .on(table.leaseUntil, table.conversationId)
      .where(sql`${table.activeRunId} IS NOT NULL`),
  ],
);

export const conversationRunItems = sqliteTable(
  "conversation_run_items",
  {
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    inboxItemId: text("inbox_item_id")
      .notNull()
      .references(() => conversationInbox.id),
    position: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.position] }),
    unique("conversation_run_items_run_item").on(table.runId, table.inboxItemId),
    check("conversation_run_items_position", sql`${table.position} >= 0`),
  ],
);

export const memorySchedule = sqliteTable(
  "memory_schedule",
  {
    conversationId: text("conversation_id").primaryKey(),
    digestedThroughAt: text("digested_through_at"),
    digestedThroughId: text("digested_through_id"),
    attempts: integer().notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseUntil: text("lease_until"),
    activeRunId: text("active_run_id").references(() => agentRuns.id),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check(
      "memory_schedule_lease",
      sql`(${table.leaseOwner} IS NULL AND ${table.leaseUntil} IS NULL AND ${table.activeRunId} IS NULL)
        OR (${table.leaseOwner} IS NOT NULL AND ${table.leaseUntil} IS NOT NULL AND ${table.activeRunId} IS NOT NULL)`,
    ),
    check(
      "memory_schedule_watermark",
      sql`(${table.digestedThroughAt} IS NULL AND ${table.digestedThroughId} IS NULL)
        OR (${table.digestedThroughAt} IS NOT NULL AND ${table.digestedThroughId} IS NOT NULL)`,
    ),
    check("memory_schedule_attempts", sql`${table.attempts} >= 0`),
  ],
);

export const evaluationPending = sqliteTable(
  "evaluation_pending",
  {
    runId: text("run_id")
      .primaryKey()
      .references(() => agentRuns.id),
    createdAt: text("created_at").notNull(),
    leaseOwner: text("lease_owner"),
    leaseUntil: text("lease_until"),
  },
  (table) => [
    check(
      "evaluation_pending_lease",
      sql`(${table.leaseOwner} IS NULL AND ${table.leaseUntil} IS NULL)
        OR (${table.leaseOwner} IS NOT NULL AND ${table.leaseUntil} IS NOT NULL)`,
    ),
    index("evaluation_pending_created").on(table.createdAt, table.runId),
  ],
);

export const evaluationRuns = sqliteTable(
  "evaluation_runs",
  {
    id: text().primaryKey(),
    role: text({ enum: ["conversation", "worker", "memory", "journey"] }).notNull(),
    subjectRunId: text("subject_run_id").references(() => agentRuns.id),
    evaluatorRunId: text("evaluator_run_id").references(() => agentRuns.id),
    caseId: text("case_id").notNull(),
    status: text({ enum: ["running", "succeeded", "failed"] }).notNull(),
    configuration: text("configuration_json", { mode: "json" }).notNull().$type<unknown>(),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at"),
    error: text(),
  },
  (table) => [
    check(
      "evaluation_runs_role",
      sql`${table.role} IN ('conversation', 'worker', 'memory', 'journey')`,
    ),
    check(
      "evaluation_runs_terminal_completion",
      sql`(${table.status} = 'running' AND ${table.completedAt} IS NULL)
        OR (${table.status} IN ('succeeded', 'failed') AND ${table.completedAt} IS NOT NULL)`,
    ),
  ],
);

export const evaluationResults = sqliteTable(
  "evaluation_results",
  {
    id: text().primaryKey(),
    evaluationRunId: text("evaluation_run_id")
      .notNull()
      .references(() => evaluationRuns.id, { onDelete: "cascade" }),
    metric: text().notNull(),
    score: real(),
    passed: integer({ mode: "boolean" }),
    detail: text("detail_json", { mode: "json" }).notNull().$type<unknown>(),
  },
  (table) => [unique("evaluation_results_run_metric").on(table.evaluationRunId, table.metric)],
);

export const evaluationAnnotations = sqliteTable(
  "evaluation_annotations",
  {
    id: text().primaryKey(),
    evaluationRunId: text("evaluation_run_id")
      .notNull()
      .references(() => evaluationRuns.id, { onDelete: "cascade" }),
    label: text().notNull(),
    value: text().notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("evaluation_annotations_run").on(table.evaluationRunId, table.createdAt, table.id),
  ],
);

export const episodes = sqliteTable(
  "episodes",
  {
    id: text().primaryKey(),
    conversationId: text("conversation_id"),
    taskId: text("task_id").references(() => tasks.id),
    kind: text({ enum: ["conversation", "task", "correction"] }).notNull(),
    summary: text().notNull(),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [check("episodes_kind", sql`${table.kind} IN ('conversation', 'task', 'correction')`)],
);

export const episodeObservations = sqliteTable(
  "episode_observations",
  {
    episodeId: text("episode_id")
      .notNull()
      .references(() => episodes.id, { onDelete: "cascade" }),
    observationId: text("observation_id")
      .notNull()
      .references(() => observations.id),
    position: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.episodeId, table.position] }),
    unique("episode_observations_episode_observation").on(table.episodeId, table.observationId),
    check("episode_observations_position", sql`${table.position} >= 0`),
  ],
);

export const entities = sqliteTable("entities", {
  id: text().primaryKey(),
  kind: text().notNull(),
  canonicalName: text("canonical_name").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const identityLinks = sqliteTable(
  "identity_links",
  {
    id: text().primaryKey(),
    entityId: text("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    namespace: text().notNull(),
    nativeId: text("native_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [unique("identity_links_namespace_native").on(table.namespace, table.nativeId)],
);

export const predicateDefinitions = sqliteTable("predicate_definitions", {
  id: text().primaryKey(),
  name: text().notNull().unique(),
  description: text().notNull(),
  valueSchema: text("value_schema_json", { mode: "json" }).notNull().$type<unknown>(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const memoryPatches = sqliteTable(
  "memory_patches",
  {
    id: text().primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id),
    status: text({ enum: ["pending", "applied", "rejected"] }).notNull(),
    source: text("source_json", { mode: "json" }).notNull().$type<unknown>(),
    error: text(),
    createdAt: text("created_at").notNull(),
    appliedAt: text("applied_at"),
  },
  (table) => [
    check("memory_patches_status", sql`${table.status} IN ('pending', 'applied', 'rejected')`),
  ],
);

export const claims = sqliteTable(
  "claims",
  {
    id: text().primaryKey(),
    entityId: text("entity_id")
      .notNull()
      .references(() => entities.id),
    predicateId: text("predicate_id")
      .notNull()
      .references(() => predicateDefinitions.id),
    value: text("value_json", { mode: "json" }).notNull().$type<unknown>(),
    confidence: text({ enum: ["low", "medium", "high", "confirmed"] }).notNull(),
    version: integer().notNull(),
    supersedesClaimId: text("supersedes_claim_id").references((): AnySQLiteColumn => claims.id),
    createdByPatchId: text("created_by_patch_id")
      .notNull()
      .references(() => memoryPatches.id),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("claims_confidence", sql`${table.confidence} IN ('low', 'medium', 'high', 'confirmed')`),
    check("claims_positive_version", sql`${table.version} > 0`),
    unique("claims_entity_predicate_version").on(table.entityId, table.predicateId, table.version),
    index("claims_created_by_patch").on(table.createdByPatchId),
    uniqueIndex("claims_one_successor")
      .on(table.supersedesClaimId)
      .where(sql`${table.supersedesClaimId} IS NOT NULL`),
  ],
);

export const claimEvidence = sqliteTable(
  "claim_evidence",
  {
    claimId: text("claim_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    observationId: text("observation_id")
      .notNull()
      .references(() => observations.id),
  },
  (table) => [primaryKey({ columns: [table.claimId, table.observationId] })],
);

export const memoryPatchOperations = sqliteTable(
  "memory_patch_operations",
  {
    id: text().primaryKey(),
    patchId: text("patch_id")
      .notNull()
      .references(() => memoryPatches.id, { onDelete: "cascade" }),
    position: integer().notNull(),
    operation: text({ enum: ["create", "reinforce", "supersede"] }).notNull(),
    claimId: text("claim_id").references(() => claims.id),
    expectedVersion: integer("expected_version"),
    payload: text("payload_json", { mode: "json" }).notNull().$type<unknown>(),
  },
  (table) => [
    check(
      "memory_patch_operations_operation",
      sql`${table.operation} IN ('create', 'reinforce', 'supersede')`,
    ),
    unique("memory_patch_operations_patch_position").on(table.patchId, table.position),
    check("memory_patch_operations_position", sql`${table.position} >= 0`),
    check(
      "memory_patch_operations_expected_version",
      sql`${table.expectedVersion} IS NULL OR ${table.expectedVersion} > 0`,
    ),
  ],
);

export const skills = sqliteTable("skills", {
  id: text().primaryKey(),
  name: text().notNull().unique(),
  description: text().notNull(),
  instructions: text().notNull(),
  revision: text().notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const runSkills = sqliteTable(
  "run_skills",
  {
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id),
    revision: text().notNull(),
    instructionsSnapshot: text("instructions_snapshot").notNull(),
  },
  (table) => [primaryKey({ columns: [table.runId, table.skillId] })],
);
