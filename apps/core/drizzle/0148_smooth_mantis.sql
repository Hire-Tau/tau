-- Recreate agent_status so the final lifecycle value is usable by the backfill in this
-- transactional migration. PostgreSQL forbids using a newly appended enum value before commit.
ALTER TYPE "public"."agent_status" RENAME TO "agent_status_old";--> statement-breakpoint
CREATE TYPE "public"."agent_status" AS ENUM('idle', 'active', 'waiting-input', 'compacting', 'resetting', 'dormant', 'terminated');--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "status" TYPE "public"."agent_status" USING "status"::text::"public"."agent_status";--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "status" SET DEFAULT 'idle';--> statement-breakpoint
DROP TYPE "public"."agent_status_old";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "dormant_at" timestamp;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "wake_eligible" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- Backfill final agent lifecycle status. No existing row becomes dormant.
UPDATE "agents"
SET "status" = 'terminated',
    "metadata" = COALESCE("metadata", '{}'::jsonb) || '{"finalCleanupPending":true}'::jsonb
WHERE "terminated_at" IS NOT NULL AND "status" <> 'terminated';
