CREATE TABLE "work_stream_continuations" (
	"work_stream_id" uuid PRIMARY KEY NOT NULL,
	"assignee_agent_id" uuid,
	"generation" integer DEFAULT 1 NOT NULL,
	"cycle_started_at" timestamp DEFAULT now() NOT NULL,
	"status" varchar(20) DEFAULT 'idle' NOT NULL,
	"trigger_execution_id" uuid,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"delivery_attempt_count" integer DEFAULT 0 NOT NULL,
	"client_id" text,
	"next_attempt_at" timestamp,
	"claimed_at" timestamp,
	"last_delivered_at" timestamp,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "work_stream_continuations" ADD CONSTRAINT "work_stream_continuations_work_stream_id_work_streams_id_fk" FOREIGN KEY ("work_stream_id") REFERENCES "public"."work_streams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_stream_continuations" ADD CONSTRAINT "work_stream_continuations_assignee_agent_id_agents_id_fk" FOREIGN KEY ("assignee_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_stream_continuations" ADD CONSTRAINT "work_stream_continuations_trigger_execution_id_executions_id_fk" FOREIGN KEY ("trigger_execution_id") REFERENCES "public"."executions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_work_stream_continuations_due" ON "work_stream_continuations" USING btree ("status","next_attempt_at");