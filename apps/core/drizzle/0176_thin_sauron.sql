CREATE TABLE "channel_direct_agents" (
	"chat_id" uuid NOT NULL,
	"squad_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	CONSTRAINT "channel_direct_agent_scope_unique" UNIQUE("chat_id","squad_id")
);
--> statement-breakpoint
CREATE TABLE "channel_direct_chats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"link_id" uuid NOT NULL,
	"channel_id" text NOT NULL,
	"thread_id" text DEFAULT '' NOT NULL,
	"squad_id" uuid,
	CONSTRAINT "channel_direct_chat_identity_unique" UNIQUE("link_id","channel_id","thread_id")
);
--> statement-breakpoint
ALTER TABLE "channel_direct_agents" ADD CONSTRAINT "channel_direct_agents_chat_id_channel_direct_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."channel_direct_chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_direct_agents" ADD CONSTRAINT "channel_direct_agents_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_direct_agents" ADD CONSTRAINT "channel_direct_agents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_direct_chats" ADD CONSTRAINT "channel_direct_chats_link_id_channel_identity_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."channel_identity_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_direct_chats" ADD CONSTRAINT "channel_direct_chats_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE set null ON UPDATE no action;