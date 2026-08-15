CREATE TABLE `media_descriptions` (
	`ref` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`mimetype` text,
	`description` text,
	`failure_reason` text,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "media_descriptions_status" CHECK("media_descriptions"."status" IN ('described', 'failed')),
	CONSTRAINT "media_descriptions_described_has_text" CHECK(("media_descriptions"."status" <> 'described') OR ("media_descriptions"."description" IS NOT NULL))
);
