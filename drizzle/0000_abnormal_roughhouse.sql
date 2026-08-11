CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`role` text NOT NULL,
	`conversation_id` text,
	`task_id` text,
	`status` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`thinking` text NOT NULL,
	`max_output_tokens` integer NOT NULL,
	`prompt_version` text NOT NULL,
	`input_json` text NOT NULL,
	`result_json` text,
	`error` text,
	`started_at` text NOT NULL,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "agent_runs_role" CHECK("agent_runs"."role" IN ('conversation', 'worker', 'memory', 'evaluator')),
	CONSTRAINT "agent_runs_thinking" CHECK("agent_runs"."thinking" IN ('off', 'low', 'medium', 'high')),
	CONSTRAINT "agent_runs_positive_max_tokens" CHECK("agent_runs"."max_output_tokens" > 0),
	CONSTRAINT "agent_runs_terminal_completion" CHECK(("agent_runs"."status" = 'running' AND "agent_runs"."completed_at" IS NULL)
        OR ("agent_runs"."status" IN ('succeeded', 'failed') AND "agent_runs"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `agent_runs_conversation_started` ON `agent_runs` (`conversation_id`,`started_at`,`id`);--> statement-breakpoint
CREATE INDEX `agent_runs_task_started` ON `agent_runs` (`task_id`,`started_at`,`id`);--> statement-breakpoint
CREATE TABLE `claim_evidence` (
	`claim_id` text NOT NULL,
	`observation_id` text NOT NULL,
	PRIMARY KEY(`claim_id`, `observation_id`),
	FOREIGN KEY (`claim_id`) REFERENCES `claims`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`observation_id`) REFERENCES `observations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `claims` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_id` text NOT NULL,
	`predicate_id` text NOT NULL,
	`value_json` text NOT NULL,
	`confidence` text NOT NULL,
	`version` integer NOT NULL,
	`supersedes_claim_id` text,
	`created_by_patch_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`predicate_id`) REFERENCES `predicate_definitions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supersedes_claim_id`) REFERENCES `claims`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_patch_id`) REFERENCES `memory_patches`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "claims_confidence" CHECK("claims"."confidence" IN ('low', 'medium', 'high', 'confirmed')),
	CONSTRAINT "claims_positive_version" CHECK("claims"."version" > 0)
);
--> statement-breakpoint
CREATE INDEX `claims_created_by_patch` ON `claims` (`created_by_patch_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `claims_one_successor` ON `claims` (`supersedes_claim_id`) WHERE "claims"."supersedes_claim_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `claims_entity_predicate_version` ON `claims` (`entity_id`,`predicate_id`,`version`);--> statement-breakpoint
CREATE TABLE `conversation_inbox` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`kind` text NOT NULL,
	`reference_id` text NOT NULL,
	`created_at` text NOT NULL,
	`claimed_by_run_id` text,
	`consumed_by_run_id` text,
	`consumed_at` text,
	FOREIGN KEY (`claimed_by_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`consumed_by_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "conversation_inbox_kind" CHECK("conversation_inbox"."kind" IN ('message', 'task_update')),
	CONSTRAINT "conversation_inbox_consumption" CHECK(("conversation_inbox"."consumed_by_run_id" IS NULL AND "conversation_inbox"."consumed_at" IS NULL)
        OR ("conversation_inbox"."consumed_by_run_id" IS NOT NULL AND "conversation_inbox"."consumed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `conversation_inbox_pending` ON `conversation_inbox` (`conversation_id`,`created_at`,`id`) WHERE "conversation_inbox"."consumed_by_run_id" IS NULL;--> statement-breakpoint
CREATE INDEX `conversation_inbox_claimed` ON `conversation_inbox` (`claimed_by_run_id`) WHERE "conversation_inbox"."claimed_by_run_id" IS NOT NULL AND "conversation_inbox"."consumed_by_run_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_inbox_reference` ON `conversation_inbox` (`kind`,`reference_id`);--> statement-breakpoint
CREATE TABLE `conversation_run_items` (
	`run_id` text NOT NULL,
	`inbox_item_id` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`run_id`, `position`),
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inbox_item_id`) REFERENCES `conversation_inbox`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "conversation_run_items_position" CHECK("conversation_run_items"."position" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_run_items_run_item` ON `conversation_run_items` (`run_id`,`inbox_item_id`);--> statement-breakpoint
CREATE TABLE `conversation_schedule` (
	`conversation_id` text PRIMARY KEY NOT NULL,
	`first_pending_at` text,
	`latest_pending_at` text,
	`due_at` text,
	`lease_owner` text,
	`lease_until` text,
	CONSTRAINT "conversation_schedule_lease" CHECK(("conversation_schedule"."lease_owner" IS NULL AND "conversation_schedule"."lease_until" IS NULL)
        OR ("conversation_schedule"."lease_owner" IS NOT NULL AND "conversation_schedule"."lease_until" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `entities` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`canonical_name` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `episode_observations` (
	`episode_id` text NOT NULL,
	`observation_id` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`episode_id`, `position`),
	FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`observation_id`) REFERENCES `observations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "episode_observations_position" CHECK("episode_observations"."position" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `episode_observations_episode_observation` ON `episode_observations` (`episode_id`,`observation_id`);--> statement-breakpoint
CREATE TABLE `episodes` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text,
	`task_id` text,
	`kind` text NOT NULL,
	`summary` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "episodes_kind" CHECK("episodes"."kind" IN ('conversation', 'task', 'correction'))
);
--> statement-breakpoint
CREATE TABLE `evaluation_annotations` (
	`id` text PRIMARY KEY NOT NULL,
	`evaluation_run_id` text NOT NULL,
	`label` text NOT NULL,
	`value` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`evaluation_run_id`) REFERENCES `evaluation_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `evaluation_annotations_run` ON `evaluation_annotations` (`evaluation_run_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `evaluation_results` (
	`id` text PRIMARY KEY NOT NULL,
	`evaluation_run_id` text NOT NULL,
	`metric` text NOT NULL,
	`score` real,
	`passed` integer,
	`detail_json` text NOT NULL,
	FOREIGN KEY (`evaluation_run_id`) REFERENCES `evaluation_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `evaluation_results_run_metric` ON `evaluation_results` (`evaluation_run_id`,`metric`);--> statement-breakpoint
CREATE TABLE `evaluation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`role` text NOT NULL,
	`subject_run_id` text,
	`evaluator_run_id` text,
	`case_id` text NOT NULL,
	`status` text NOT NULL,
	`configuration_json` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	`error` text,
	FOREIGN KEY (`subject_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`evaluator_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "evaluation_runs_role" CHECK("evaluation_runs"."role" IN ('conversation', 'worker', 'memory', 'journey')),
	CONSTRAINT "evaluation_runs_terminal_completion" CHECK(("evaluation_runs"."status" = 'running' AND "evaluation_runs"."completed_at" IS NULL)
        OR ("evaluation_runs"."status" IN ('succeeded', 'failed') AND "evaluation_runs"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `identity_links` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_id` text NOT NULL,
	`namespace` text NOT NULL,
	`native_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `identity_links_namespace_native` ON `identity_links` (`namespace`,`native_id`);--> statement-breakpoint
CREATE TABLE `memory_patch_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`patch_id` text NOT NULL,
	`position` integer NOT NULL,
	`operation` text NOT NULL,
	`claim_id` text,
	`expected_version` integer,
	`payload_json` text NOT NULL,
	FOREIGN KEY (`patch_id`) REFERENCES `memory_patches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`claim_id`) REFERENCES `claims`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "memory_patch_operations_operation" CHECK("memory_patch_operations"."operation" IN ('create', 'reinforce', 'supersede')),
	CONSTRAINT "memory_patch_operations_position" CHECK("memory_patch_operations"."position" >= 0),
	CONSTRAINT "memory_patch_operations_expected_version" CHECK("memory_patch_operations"."expected_version" IS NULL OR "memory_patch_operations"."expected_version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memory_patch_operations_patch_position` ON `memory_patch_operations` (`patch_id`,`position`);--> statement-breakpoint
CREATE TABLE `memory_patches` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`status` text NOT NULL,
	`source_json` text NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`applied_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "memory_patches_status" CHECK("memory_patches"."status" IN ('pending', 'applied', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE `observations` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`account_id` text NOT NULL,
	`native_id` text NOT NULL,
	`conversation_id` text,
	`occurred_at` text NOT NULL,
	`kind` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "observations_source" CHECK("observations"."source" IN ('whatsapp', 'worker')),
	CONSTRAINT "observations_kind" CHECK("observations"."kind" IN ('message', 'task_request', 'worker_result', 'conversation_report'))
);
--> statement-breakpoint
CREATE INDEX `observations_conversation_occurred` ON `observations` (`conversation_id`,`occurred_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `observations_native_identity` ON `observations` (`source`,`account_id`,`native_id`);--> statement-breakpoint
CREATE TABLE `predicate_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`value_schema_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `predicate_definitions_name_unique` ON `predicate_definitions` (`name`);--> statement-breakpoint
CREATE TABLE `run_skills` (
	`run_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`revision` text NOT NULL,
	`instructions_snapshot` text NOT NULL,
	PRIMARY KEY(`run_id`, `skill_id`),
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `skills` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`instructions` text NOT NULL,
	`revision` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skills_name_unique` ON `skills` (`name`);--> statement-breakpoint
CREATE TABLE `task_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`value` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "task_artifacts_kind" CHECK("task_artifacts"."kind" IN ('text', 'file', 'url', 'json'))
);
--> statement-breakpoint
CREATE TABLE `task_updates` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`status` text NOT NULL,
	`summary` text,
	`occurred_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "task_updates_status" CHECK("task_updates"."status" IN ('queued', 'running', 'succeeded', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX `task_updates_task` ON `task_updates` (`task_id`,`occurred_at`,`id`);--> statement-breakpoint
CREATE TABLE `task_worker_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`run_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "task_worker_attempts_positive" CHECK("task_worker_attempts"."attempt" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_worker_attempts_task_attempt` ON `task_worker_attempts` (`task_id`,`attempt`);--> statement-breakpoint
CREATE UNIQUE INDEX `task_worker_attempts_run` ON `task_worker_attempts` (`run_id`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`requested_by_run_id` text NOT NULL,
	`objective` text NOT NULL,
	`instructions` text,
	`worker_profile` text NOT NULL,
	`status` text NOT NULL,
	`lease_owner` text,
	`lease_until` text,
	`result_summary` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`started_at` text,
	`completed_at` text,
	FOREIGN KEY (`requested_by_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tasks_lifecycle" CHECK(("tasks"."status" = 'queued' AND "tasks"."started_at" IS NULL AND "tasks"."completed_at" IS NULL)
        OR ("tasks"."status" = 'running' AND "tasks"."started_at" IS NOT NULL AND "tasks"."completed_at" IS NULL)
        OR ("tasks"."status" IN ('succeeded', 'failed', 'cancelled') AND "tasks"."completed_at" IS NOT NULL)),
	CONSTRAINT "tasks_active_lease" CHECK(("tasks"."status" = 'running' AND "tasks"."lease_owner" IS NOT NULL AND "tasks"."lease_until" IS NOT NULL)
        OR ("tasks"."status" != 'running' AND "tasks"."lease_owner" IS NULL AND "tasks"."lease_until" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `tasks_conversation_updated` ON `tasks` (`conversation_id`,`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `tasks_queued` ON `tasks` (`created_at`,`id`) WHERE "tasks"."status" = 'queued';--> statement-breakpoint
CREATE INDEX `tasks_expired_lease` ON `tasks` (`lease_until`,`id`) WHERE "tasks"."status" = 'running';--> statement-breakpoint
CREATE TABLE `tool_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`call_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`input_json` text NOT NULL,
	`outcome` text NOT NULL,
	`output_json` text,
	`error` text,
	`started_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "tool_calls_terminal_completion" CHECK(("tool_calls"."outcome" = 'running' AND "tool_calls"."completed_at" IS NULL)
        OR ("tool_calls"."outcome" IN ('succeeded', 'failed') AND "tool_calls"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tool_calls_run_call` ON `tool_calls` (`run_id`,`call_id`);
--> statement-breakpoint
CREATE TRIGGER `claims_require_valid_lineage`
BEFORE INSERT ON `claims`
BEGIN
	SELECT CASE
		WHEN NEW.`supersedes_claim_id` IS NULL AND NEW.`version` != 1
		THEN RAISE(ABORT, 'initial claim version must be 1')
	END;
	SELECT CASE
		WHEN NEW.`supersedes_claim_id` IS NOT NULL AND NOT EXISTS (
			SELECT 1
			FROM `claims` previous
			WHERE previous.`id` = NEW.`supersedes_claim_id`
				AND previous.`entity_id` = NEW.`entity_id`
				AND previous.`predicate_id` = NEW.`predicate_id`
				AND previous.`version` = NEW.`version` - 1
		)
		THEN RAISE(ABORT, 'superseding claim has invalid lineage')
	END;
END;
--> statement-breakpoint
CREATE TRIGGER `memory_patches_validate_before_apply`
BEFORE UPDATE OF `status` ON `memory_patches`
WHEN NEW.`status` = 'applied'
BEGIN
	SELECT CASE
		WHEN NOT EXISTS (
			SELECT 1 FROM `memory_patch_operations` WHERE `patch_id` = NEW.`id`
		)
		THEN RAISE(ABORT, 'memory patch has no operations')
	END;
	SELECT CASE
		WHEN EXISTS (
			SELECT 1
			FROM `claims`
			WHERE `created_by_patch_id` = NEW.`id`
				AND NOT EXISTS (
					SELECT 1
					FROM `claim_evidence`
					WHERE `claim_evidence`.`claim_id` = `claims`.`id`
				)
		)
		THEN RAISE(ABORT, 'memory patch claim has no evidence')
	END;
	SELECT CASE
		WHEN EXISTS (
			SELECT 1
			FROM `memory_patch_operations` operation
			JOIN `claims` current_claim ON current_claim.`id` = operation.`claim_id`
			JOIN `claims` previous_claim ON previous_claim.`id` = current_claim.`supersedes_claim_id`
			WHERE operation.`patch_id` = NEW.`id`
				AND operation.`operation` = 'supersede'
				AND operation.`expected_version` != previous_claim.`version`
		)
		THEN RAISE(ABORT, 'memory patch expected version is stale')
	END;
END;