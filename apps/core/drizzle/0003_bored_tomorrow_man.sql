ALTER TABLE "schedules" ADD COLUMN "last_webhook_trigger_at" timestamp;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "webhook_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "webhook_token_hash" varchar(64);