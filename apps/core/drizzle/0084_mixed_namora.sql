CREATE TYPE "public"."operations_recommendation_status" AS ENUM('open', 'acknowledged', 'dismissed', 'resolved');--> statement-breakpoint
CREATE TABLE "operations_execution_analyses" (
	"execution_id" uuid PRIMARY KEY NOT NULL,
	"squad_id" uuid,
	"algorithm_version" varchar(64) NOT NULL,
	"redaction_version" varchar(64) NOT NULL,
	"result" varchar(16) NOT NULL,
	"skip_reason" varchar(80),
	"signal_count" integer DEFAULT 0 NOT NULL,
	"tool_call_count" integer DEFAULT 0 NOT NULL,
	"failed_tool_call_count" integer DEFAULT 0 NOT NULL,
	"estimated_avoidable_retries" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"token_count" integer DEFAULT 0 NOT NULL,
	"analyzed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operations_recommendation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recommendation_id" uuid NOT NULL,
	"action" varchar(32) NOT NULL,
	"actor" varchar(255) NOT NULL,
	"from_status" "operations_recommendation_status",
	"to_status" "operations_recommendation_status",
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operations_recommendation_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recommendation_id" uuid NOT NULL,
	"execution_id" uuid,
	"message_id" uuid,
	"agent_id" uuid,
	"signal_types" jsonb NOT NULL,
	"occurrence_count" integer NOT NULL,
	"summary" text NOT NULL,
	"failed_tool_call_count" integer DEFAULT 0 NOT NULL,
	"estimated_avoidable_retries" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"token_count" integer DEFAULT 0 NOT NULL,
	"observed_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "operations_recommendation_evidence_recommendation_execution_unique" UNIQUE("recommendation_id","execution_id")
);
--> statement-breakpoint
CREATE TABLE "operations_recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"squad_id" uuid NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"policy" varchar(32) DEFAULT 'recommendation-only' NOT NULL,
	"remediation_type" varchar(64) NOT NULL,
	"target" varchar(255) NOT NULL,
	"proposed_remediation" jsonb NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"status" "operations_recommendation_status" DEFAULT 'open' NOT NULL,
	"confidence" varchar(16) DEFAULT 'low' NOT NULL,
	"recurrence_count" integer DEFAULT 0 NOT NULL,
	"execution_count" integer DEFAULT 0 NOT NULL,
	"affected_agent_count" integer DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp NOT NULL,
	"last_seen_at" timestamp NOT NULL,
	"resolved_at" timestamp,
	"baseline" jsonb NOT NULL,
	"algorithm_version" varchar(64) NOT NULL,
	"redaction_version" varchar(64) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "operations_recommendations_squad_fingerprint_unique" UNIQUE("squad_id","fingerprint")
);
--> statement-breakpoint
ALTER TABLE "operations_execution_analyses" ADD CONSTRAINT "operations_execution_analyses_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations_execution_analyses" ADD CONSTRAINT "operations_execution_analyses_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations_recommendation_events" ADD CONSTRAINT "operations_recommendation_events_recommendation_id_operations_recommendations_id_fk" FOREIGN KEY ("recommendation_id") REFERENCES "public"."operations_recommendations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations_recommendation_evidence" ADD CONSTRAINT "operations_recommendation_evidence_recommendation_id_operations_recommendations_id_fk" FOREIGN KEY ("recommendation_id") REFERENCES "public"."operations_recommendations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations_recommendation_evidence" ADD CONSTRAINT "operations_recommendation_evidence_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations_recommendation_evidence" ADD CONSTRAINT "operations_recommendation_evidence_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations_recommendation_evidence" ADD CONSTRAINT "operations_recommendation_evidence_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations_recommendations" ADD CONSTRAINT "operations_recommendations_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_operations_recommendation_events_recommendation_created" ON "operations_recommendation_events" USING btree ("recommendation_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_operations_recommendation_evidence_observed" ON "operations_recommendation_evidence" USING btree ("recommendation_id","observed_at");--> statement-breakpoint
CREATE INDEX "idx_operations_recommendations_squad_status_last_seen" ON "operations_recommendations" USING btree ("squad_id","status","last_seen_at");--> statement-breakpoint
CREATE INDEX "idx_messages_agent_stream_group" ON "messages" USING btree ("agent_id",("metadata"->>'streamGroupId')) WHERE "messages"."role" = 'assistant' AND ("messages"."metadata"->>'streamGroupId') IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_messages_agent_inbox_consumed" ON "messages" USING btree ("agent_id",("metadata"->>'consumedAt')) WHERE "messages"."metadata"->>'source' = 'inbox' AND ("messages"."metadata"->>'consumedAt') IS NOT NULL;