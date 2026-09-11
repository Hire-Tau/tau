ALTER TABLE "agent_tokens" DROP CONSTRAINT "agent_tokens_channel_id_channel_instances_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_tokens" ALTER COLUMN "squad_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tokens" DROP COLUMN "channel_id";