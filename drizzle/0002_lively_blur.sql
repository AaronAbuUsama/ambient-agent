PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_conversation_schedule` (
	`conversation_id` text PRIMARY KEY NOT NULL,
	`first_pending_at` text,
	`latest_pending_at` text,
	`due_at` text,
	`lease_owner` text,
	`lease_until` text,
	`active_run_id` text,
	FOREIGN KEY (`active_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "conversation_schedule_lease" CHECK(("__new_conversation_schedule"."lease_owner" IS NULL AND "__new_conversation_schedule"."lease_until" IS NULL AND "__new_conversation_schedule"."active_run_id" IS NULL)
        OR ("__new_conversation_schedule"."lease_owner" IS NOT NULL AND "__new_conversation_schedule"."lease_until" IS NOT NULL AND "__new_conversation_schedule"."active_run_id" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_conversation_schedule`("conversation_id", "first_pending_at", "latest_pending_at", "due_at", "lease_owner", "lease_until", "active_run_id") SELECT "conversation_id", "first_pending_at", "latest_pending_at", "due_at", NULL, NULL, NULL FROM `conversation_schedule`;--> statement-breakpoint
DROP TABLE `conversation_schedule`;--> statement-breakpoint
ALTER TABLE `__new_conversation_schedule` RENAME TO `conversation_schedule`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `conversation_schedule_due` ON `conversation_schedule` (`due_at`,`conversation_id`) WHERE "conversation_schedule"."active_run_id" IS NULL AND "conversation_schedule"."due_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `conversation_schedule_expired` ON `conversation_schedule` (`lease_until`,`conversation_id`) WHERE "conversation_schedule"."active_run_id" IS NOT NULL;