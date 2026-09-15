CREATE TABLE "assistant_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"current_request_id" uuid NOT NULL,
	"agent_id" uuid,
	"kind" varchar(20) NOT NULL,
	"squad_id" uuid,
	"label" text NOT NULL,
	"status" varchar(20) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistant_updates" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"task_id" uuid,
	"request_id" uuid,
	"sequence" integer NOT NULL,
	"reported_status" varchar(20),
	"processed_at" timestamp with time zone,
	"seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_updates_sequence" UNIQUE("conversation_id","sequence")
);
--> statement-breakpoint
ALTER TABLE "assistant_conversations" ADD COLUMN "next_update_sequence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "assistant_tasks" ADD CONSTRAINT "assistant_tasks_conversation_id_assistant_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."assistant_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_tasks" ADD CONSTRAINT "assistant_tasks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_tasks" ADD CONSTRAINT "assistant_tasks_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_updates" ADD CONSTRAINT "assistant_updates_message_id_inbox_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."inbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_updates" ADD CONSTRAINT "assistant_updates_conversation_id_assistant_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."assistant_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_updates" ADD CONSTRAINT "assistant_updates_task_id_assistant_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."assistant_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_assistant_tasks_conversation_updated" ON "assistant_tasks" USING btree ("conversation_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "idx_assistant_updates_unseen" ON "assistant_updates" USING btree ("conversation_id","sequence") WHERE "assistant_updates"."seen_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_assistant_updates_unprocessed" ON "assistant_updates" USING btree ("conversation_id","sequence") WHERE "assistant_updates"."processed_at" IS NULL;