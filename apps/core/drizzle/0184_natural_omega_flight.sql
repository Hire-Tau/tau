ALTER TABLE "assistant_conversations" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "assistant_updates" ADD COLUMN "forwarded_message_id" uuid;--> statement-breakpoint
ALTER TABLE "assistant_updates" ADD COLUMN "summarized_message_id" uuid;--> statement-breakpoint
ALTER TABLE "assistant_conversations" ADD CONSTRAINT "assistant_conversations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_assistant_conversations_agent" ON "assistant_conversations" USING btree ("agent_id");