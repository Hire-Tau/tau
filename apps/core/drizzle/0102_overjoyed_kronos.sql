-- Recreate execution_status so waiting-maintenance is usable by later migrations in the
-- same transactional batch. PostgreSQL forbids using a newly appended enum value
-- before commit; a freshly created enum has no such restriction (migration 0045 pattern).
ALTER TYPE "public"."execution_status" RENAME TO "execution_status_old";--> statement-breakpoint
CREATE TYPE "public"."execution_status" AS ENUM('queued', 'waiting-maintenance', 'waiting-sandbox', 'running', 'stopping', 'stopped', 'completed', 'failed');--> statement-breakpoint
ALTER TABLE "executions" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "executions" ALTER COLUMN "status" TYPE "public"."execution_status" USING "status"::text::"public"."execution_status";--> statement-breakpoint
ALTER TABLE "executions" ALTER COLUMN "status" SET DEFAULT 'queued';--> statement-breakpoint
DROP TYPE "public"."execution_status_old";
