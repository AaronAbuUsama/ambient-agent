CREATE TABLE `evaluation_pending` (
	`run_id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`lease_owner` text,
	`lease_until` text,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "evaluation_pending_lease" CHECK(("evaluation_pending"."lease_owner" IS NULL AND "evaluation_pending"."lease_until" IS NULL)
        OR ("evaluation_pending"."lease_owner" IS NOT NULL AND "evaluation_pending"."lease_until" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `evaluation_pending_created` ON `evaluation_pending` (`created_at`,`run_id`);