ALTER TABLE "executions" ADD COLUMN "startup_retry_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "startup_retry_at" timestamp with time zone;