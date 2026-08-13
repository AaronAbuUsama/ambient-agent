CREATE TABLE `memory_schedule` (
	`conversation_id` text PRIMARY KEY NOT NULL,
	`digested_through_at` text,
	`digested_through_id` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`lease_owner` text,
	`lease_until` text,
	`active_run_id` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`active_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "memory_schedule_lease" CHECK(("memory_schedule"."lease_owner" IS NULL AND "memory_schedule"."lease_until" IS NULL AND "memory_schedule"."active_run_id" IS NULL)
        OR ("memory_schedule"."lease_owner" IS NOT NULL AND "memory_schedule"."lease_until" IS NOT NULL AND "memory_schedule"."active_run_id" IS NOT NULL)),
	CONSTRAINT "memory_schedule_watermark" CHECK(("memory_schedule"."digested_through_at" IS NULL AND "memory_schedule"."digested_through_id" IS NULL)
        OR ("memory_schedule"."digested_through_at" IS NOT NULL AND "memory_schedule"."digested_through_id" IS NOT NULL)),
	CONSTRAINT "memory_schedule_attempts" CHECK("memory_schedule"."attempts" >= 0)
);
