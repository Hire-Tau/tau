ALTER TABLE "work_streams" ADD COLUMN "owner_agent_id" uuid;--> statement-breakpoint
UPDATE "agents"
SET "squad_id" = (
  SELECT "id"
  FROM "squads"
  ORDER BY "created_at" ASC, "id" ASC
  LIMIT 1
)
WHERE "agent_type_id" = 'concierge'
  AND "squad_id" IS NULL
  AND EXISTS (SELECT 1 FROM "squads");--> statement-breakpoint
ALTER TABLE "work_streams" ADD CONSTRAINT "work_streams_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
