CREATE TABLE "storage_monitor" (
	"id" text PRIMARY KEY NOT NULL,
	"snapshot" jsonb,
	"requested_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"lease_id" uuid,
	"lease_until" timestamp with time zone,
	"error" text,
	"levels" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pending_alerts" jsonb DEFAULT '[]'::jsonb NOT NULL
);
