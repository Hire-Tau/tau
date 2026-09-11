CREATE TYPE "public"."work_stream_priority" AS ENUM('critical', 'high', 'normal', 'low');--> statement-breakpoint
ALTER TYPE "public"."work_stream_status" ADD VALUE 'queued' BEFORE 'in_progress';--> statement-breakpoint
ALTER TABLE "squads" ADD COLUMN "max_concurrent_work_streams" integer;--> statement-breakpoint
ALTER TABLE "work_streams" ADD COLUMN "priority" "work_stream_priority" DEFAULT 'normal' NOT NULL;