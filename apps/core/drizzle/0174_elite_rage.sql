CREATE TABLE "assistant_conversation_agents" (
	"conversation_id" uuid NOT NULL,
	"squad_id" uuid,
	"agent_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_conversation_agents_conversation_id_agent_id_pk" PRIMARY KEY("conversation_id","agent_id")
);
--> statement-breakpoint
ALTER TABLE "assistant_conversations" DROP CONSTRAINT "assistant_conversations_manager_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "assistant_conversation_agents" ADD CONSTRAINT "assistant_conversation_agents_conversation_id_assistant_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."assistant_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_conversation_agents" ADD CONSTRAINT "assistant_conversation_agents_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_conversation_agents" ADD CONSTRAINT "assistant_conversation_agents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_assistant_conversation_agents_general" ON "assistant_conversation_agents" USING btree ("conversation_id") WHERE "assistant_conversation_agents"."squad_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_assistant_conversation_agents_squad" ON "assistant_conversation_agents" USING btree ("conversation_id","squad_id") WHERE "assistant_conversation_agents"."squad_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_assistant_conversation_agents_agent" ON "assistant_conversation_agents" USING btree ("agent_id");--> statement-breakpoint
ALTER TABLE "assistant_conversations" DROP COLUMN "manager_agent_id";