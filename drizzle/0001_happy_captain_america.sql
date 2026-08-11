CREATE TABLE `whatsapp_ingestion_cursors` (
	`account_id` text PRIMARY KEY NOT NULL,
	`after_seq` integer NOT NULL,
	`state` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "whatsapp_ingestion_cursors_nonnegative" CHECK("whatsapp_ingestion_cursors"."after_seq" >= 0),
	CONSTRAINT "whatsapp_ingestion_cursors_state" CHECK("whatsapp_ingestion_cursors"."state" IN ('bootstrapping', 'active'))
);
