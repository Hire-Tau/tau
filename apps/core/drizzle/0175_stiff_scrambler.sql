ALTER TABLE "channel_instances" DROP CONSTRAINT "channel_instances_concierge_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "channel_instances" ADD COLUMN "allowed_channel_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_instances" ADD COLUMN "denied_channel_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_instances" DROP COLUMN "concierge_agent_id";