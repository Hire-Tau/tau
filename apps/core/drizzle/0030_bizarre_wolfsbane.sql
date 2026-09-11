UPDATE "public"."executions"
SET "status" = 'stopped', "ended_at" = COALESCE("ended_at", NOW())
WHERE "status" IN ('pausing', 'paused');--> statement-breakpoint
ALTER TABLE "public"."executions" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "public"."executions" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."execution_status";--> statement-breakpoint
CREATE TYPE "public"."execution_status" AS ENUM('queued', 'running', 'stopping', 'stopped', 'completed', 'failed');--> statement-breakpoint
ALTER TABLE "public"."executions" ALTER COLUMN "status" SET DATA TYPE "public"."execution_status" USING "status"::"public"."execution_status";--> statement-breakpoint
ALTER TABLE "public"."executions" ALTER COLUMN "status" SET DEFAULT 'queued';