ALTER TABLE "schedules" ADD COLUMN "last_skipped_at" timestamp;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "skip_count" integer DEFAULT 0 NOT NULL;