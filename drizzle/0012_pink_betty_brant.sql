CREATE TABLE `agent_todos` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`note` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`settled_at` text,
	`outcome` text,
	CONSTRAINT "agent_todos_status" CHECK("agent_todos"."status" IN ('open', 'done', 'dropped'))
);
--> statement-breakpoint
CREATE INDEX `agent_todos_conversation` ON `agent_todos` (`conversation_id`,`status`);