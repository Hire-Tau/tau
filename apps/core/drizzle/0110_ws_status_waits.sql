-- Work-stream status consolidation: two live statuses + typed waits.
-- Stored status shrinks to queued|active|done|canceled; everything richer
-- becomes a typed wait record in work_stream_waits. Backfill maps:
--   pending -> queued
--   in_progress -> active
--   blocked -> open wait first (dependency waits when unsatisfied dependsOn,
--     else a manual wait carrying the blocked message), then active when the
--     blocked transition is within the squad grace, else queued
--   review -> active + open review wait
-- The old blocked/review prompt storage is dropped after its content is
-- migrated into wait messages. Hand-written (drizzle-kit's generated order
-- would have dropped the prompts before the backfill and cast old enum
-- values without mapping); the meta snapshot matches the final schema.
CREATE TYPE "public"."work_stream_wait_created_by" AS ENUM('system', 'agent', 'manager', 'operator');--> statement-breakpoint
CREATE TYPE "public"."work_stream_wait_type" AS ENUM('dependency', 'question', 'review', 'manual');--> statement-breakpoint
CREATE TABLE "work_stream_waits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_stream_id" uuid NOT NULL,
	"type" "work_stream_wait_type" NOT NULL,
	"reference_id" uuid,
	"message" text,
	"created_by" "work_stream_wait_created_by" DEFAULT 'system' NOT NULL,
	"created_by_agent_id" uuid,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"resolution" text,
	"resolution_note" text
);
--> statement-breakpoint
ALTER TABLE "work_stream_waits" ADD CONSTRAINT "work_stream_waits_work_stream_id_work_streams_id_fk" FOREIGN KEY ("work_stream_id") REFERENCES "public"."work_streams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_stream_waits" ADD CONSTRAINT "work_stream_waits_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_work_stream_waits_one_open_review" ON "work_stream_waits" USING btree ("work_stream_id") WHERE "work_stream_waits"."type" = 'review' AND "work_stream_waits"."closed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_work_stream_waits_open" ON "work_stream_waits" USING btree ("work_stream_id") WHERE "work_stream_waits"."closed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_work_stream_waits_reference" ON "work_stream_waits" USING btree ("reference_id");--> statement-breakpoint
ALTER TABLE "squads" ADD COLUMN "blocked_grace_minutes" integer;--> statement-breakpoint
INSERT INTO "work_stream_waits" ("work_stream_id", "type", "reference_id", "created_by", "opened_at")
SELECT DISTINCT ws."id", 'dependency'::"public"."work_stream_wait_type", dep."id", 'system'::"public"."work_stream_wait_created_by", ws."updated_at"
FROM "work_streams" ws
JOIN LATERAL unnest(ws."depends_on") AS d(dep_id) ON true
JOIN "work_streams" dep ON dep."id" = d.dep_id
WHERE ws."status"::text IN ('pending', 'queued', 'in_progress', 'blocked', 'review')
  AND dep."status"::text <> 'done';--> statement-breakpoint
INSERT INTO "work_stream_waits" ("work_stream_id", "type", "message", "created_by", "opened_at")
SELECT ws."id", 'manual'::"public"."work_stream_wait_type", NULLIF(ws."blocked_prompt"->>'message', ''), 'system'::"public"."work_stream_wait_created_by", ws."updated_at"
FROM "work_streams" ws
WHERE ws."status"::text = 'blocked'
  AND NOT EXISTS (
    SELECT 1 FROM unnest(ws."depends_on") AS d(dep_id)
    JOIN "work_streams" dep ON dep."id" = d.dep_id
    WHERE dep."status"::text <> 'done'
  );--> statement-breakpoint
INSERT INTO "work_stream_waits" ("work_stream_id", "type", "message", "created_by", "opened_at")
SELECT ws."id", 'review'::"public"."work_stream_wait_type", COALESCE(NULLIF(ws."review_prompt"->>'message', ''), ws."handoff_message"), 'system'::"public"."work_stream_wait_created_by", ws."updated_at"
FROM "work_streams" ws
WHERE ws."status"::text = 'review';--> statement-breakpoint
CREATE TEMP TABLE "_ws_blocked_park" ON COMMIT DROP AS
SELECT ws."id" FROM "work_streams" ws
JOIN "squads" s ON s."id" = ws."squad_id"
WHERE ws."status"::text = 'blocked'
  AND ws."updated_at" <= clock_timestamp() - make_interval(mins => COALESCE(s."blocked_grace_minutes", 30));--> statement-breakpoint
ALTER TABLE "work_streams" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "public"."work_streams" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."work_stream_status";--> statement-breakpoint
CREATE TYPE "public"."work_stream_status" AS ENUM('queued', 'active', 'done', 'canceled');--> statement-breakpoint
UPDATE "work_streams" SET "status" = CASE "status"
  WHEN 'pending' THEN 'queued'
  WHEN 'in_progress' THEN 'active'
  WHEN 'blocked' THEN 'active'
  WHEN 'review' THEN 'active'
  ELSE "status" END;--> statement-breakpoint
UPDATE "work_streams" SET "status" = 'queued' WHERE "id" IN (SELECT "id" FROM "_ws_blocked_park");--> statement-breakpoint
ALTER TABLE "public"."work_streams" ALTER COLUMN "status" SET DATA TYPE "public"."work_stream_status" USING "status"::"public"."work_stream_status";--> statement-breakpoint
ALTER TABLE "work_streams" ALTER COLUMN "status" SET DEFAULT 'active';--> statement-breakpoint
ALTER TABLE "work_streams" DROP COLUMN "blocked_prompt";--> statement-breakpoint
ALTER TABLE "work_streams" DROP COLUMN "review_prompt";
