CREATE TABLE `memory_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`status` text NOT NULL,
	`input_json` text NOT NULL,
	`run_id` text,
	`error` text,
	`lease_owner` text,
	`lease_until` text,
	`created_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "memory_jobs_status" CHECK("memory_jobs"."status" IN ('pending', 'done', 'failed')),
	CONSTRAINT "memory_jobs_terminal" CHECK(("memory_jobs"."status" = 'pending' AND "memory_jobs"."completed_at" IS NULL)
        OR ("memory_jobs"."status" IN ('done', 'failed') AND "memory_jobs"."completed_at" IS NOT NULL)),
	CONSTRAINT "memory_jobs_lease" CHECK(("memory_jobs"."lease_owner" IS NULL AND "memory_jobs"."lease_until" IS NULL)
        OR ("memory_jobs"."lease_owner" IS NOT NULL AND "memory_jobs"."lease_until" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `memory_jobs_pending` ON `memory_jobs` (`created_at`,`id`) WHERE "memory_jobs"."status" = 'pending';