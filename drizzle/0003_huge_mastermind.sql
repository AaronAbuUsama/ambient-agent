CREATE TABLE `conversation_speakers` (
	`conversation_id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`instructions` text,
	`attend_from` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "conversation_speakers_mode" CHECK("conversation_speakers"."mode" IN ('listening', 'responding'))
);
