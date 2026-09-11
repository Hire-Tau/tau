CREATE TABLE "work_stream_flow_runs" (
	"activated" boolean DEFAULT false NOT NULL,
	"profiles" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempt_agents" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"work_stream_id" uuid PRIMARY KEY NOT NULL,
	"create_request_id" uuid NOT NULL,
	"create_request_hash" varchar(64) NOT NULL,
	"source" jsonb NOT NULL,
	"state" jsonb NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_stream_flow_transitions" (
	"work_stream_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"command" jsonb NOT NULL,
	"version" integer NOT NULL,
	"state_status" text NOT NULL,
	"active_attempt_id" integer,
	"actor_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "work_stream_flow_transitions_work_stream_id_request_id_pk" PRIMARY KEY("work_stream_id","request_id")
);
--> statement-breakpoint
CREATE TABLE "work_style_bindings" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"work_stream_id" uuid NOT NULL,
	"participant_id" text NOT NULL,
	"binding_key" text NOT NULL,
	"profile" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_styles" (
	"scope" jsonb DEFAULT '{"kind":"instance"}'::jsonb NOT NULL,
	"id" varchar(100) PRIMARY KEY NOT NULL,
	"description" text,
	"definition" jsonb NOT NULL,
	"yaml_template" jsonb,
	"yaml_field_overrides" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_types" ADD COLUMN "flow_prompt" text;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "flow_context" jsonb;--> statement-breakpoint
ALTER TABLE "work_stream_waits" ADD COLUMN "resolution_handler" text;--> statement-breakpoint
ALTER TABLE "work_streams" ADD COLUMN "pause" jsonb;--> statement-breakpoint
ALTER TABLE "work_stream_flow_runs" ADD CONSTRAINT "work_stream_flow_runs_work_stream_id_work_streams_id_fk" FOREIGN KEY ("work_stream_id") REFERENCES "public"."work_streams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_stream_flow_transitions" ADD CONSTRAINT "work_stream_flow_transitions_work_stream_id_work_stream_flow_runs_work_stream_id_fk" FOREIGN KEY ("work_stream_id") REFERENCES "public"."work_stream_flow_runs"("work_stream_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_style_bindings" ADD CONSTRAINT "work_style_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_style_bindings" ADD CONSTRAINT "work_style_bindings_work_stream_id_work_streams_id_fk" FOREIGN KEY ("work_stream_id") REFERENCES "public"."work_streams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_work_stream_flow_transition_version" ON "work_stream_flow_transitions" USING btree ("work_stream_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_work_style_binding_key" ON "work_style_bindings" USING btree ("work_stream_id","binding_key");
--> statement-breakpoint
ALTER TABLE "work_stream_waits" ADD COLUMN "flow_attempt_id" integer;
--> statement-breakpoint
CREATE TABLE "integration_output_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"work_stream_id" uuid NOT NULL,
	"subscription_id" text NOT NULL,
	"subscription" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_output_subscription_delivery" UNIQUE("event_id","work_stream_id","subscription_id")
);
--> statement-breakpoint
CREATE TABLE "integration_output_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration" text NOT NULL,
	"source_key" text NOT NULL,
	"event_key" text NOT NULL,
	"authority" jsonb NOT NULL,
	"fact" jsonb NOT NULL,
	"trigger_squad_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_error_code" text,
	"matched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_output_event_identity" UNIQUE("integration","source_key","event_key")
);
--> statement-breakpoint
CREATE TABLE "integration_output_trigger_runs" (
	"squad_id" uuid NOT NULL,
	"trigger_id" text NOT NULL,
	"source_key" text NOT NULL,
	"resource_key" text NOT NULL,
	"event_id" uuid NOT NULL,
	"work_stream_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_output_trigger_runs_squad_id_trigger_id_source_key_resource_key_pk" PRIMARY KEY("squad_id","trigger_id","source_key","resource_key")
);
--> statement-breakpoint
ALTER TABLE "integration_output_deliveries" ADD CONSTRAINT "integration_output_deliveries_event_id_integration_output_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."integration_output_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_output_deliveries" ADD CONSTRAINT "integration_output_deliveries_work_stream_id_work_stream_flow_runs_work_stream_id_fk" FOREIGN KEY ("work_stream_id") REFERENCES "public"."work_stream_flow_runs"("work_stream_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_output_trigger_runs" ADD CONSTRAINT "integration_output_trigger_runs_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_output_trigger_runs" ADD CONSTRAINT "integration_output_trigger_runs_event_id_integration_output_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."integration_output_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_output_trigger_runs" ADD CONSTRAINT "integration_output_trigger_runs_work_stream_id_work_streams_id_fk" FOREIGN KEY ("work_stream_id") REFERENCES "public"."work_streams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "integration_output_delivery_stream" ON "integration_output_deliveries" USING btree ("work_stream_id","status");
--> statement-breakpoint
CREATE TABLE "integration_device_authorizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"client_binding" jsonb NOT NULL,
	"user_code" varchar(64) NOT NULL,
	"verification_uri" varchar(2048) NOT NULL,
	"encrypted_device_code" text,
	"device_code_iv" text,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"interval_seconds" integer NOT NULL,
	"next_poll_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "integration_device_authorizations_status" CHECK ("integration_device_authorizations"."status" in ('pending', 'authorized')),
	CONSTRAINT "integration_device_authorizations_interval" CHECK ("integration_device_authorizations"."interval_seconds" between 1 and 3600),
	CONSTRAINT "integration_device_authorizations_secret" CHECK (("integration_device_authorizations"."status" = 'pending' AND "integration_device_authorizations"."encrypted_device_code" IS NOT NULL AND "integration_device_authorizations"."device_code_iv" IS NOT NULL) OR ("integration_device_authorizations"."status" = 'authorized' AND "integration_device_authorizations"."encrypted_device_code" IS NULL AND "integration_device_authorizations"."device_code_iv" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "integration_authorization_flow_receipts" DROP CONSTRAINT "integration_auth_receipts_authority_check";--> statement-breakpoint
ALTER TABLE "integration_device_authorizations" ADD CONSTRAINT "integration_device_authorizations_id_integration_authorization_flow_receipts_local_flow_id_fk" FOREIGN KEY ("id") REFERENCES "public"."integration_authorization_flow_receipts"("local_flow_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_device_authorizations" ADD CONSTRAINT "integration_device_authorizations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_integration_device_authorizations_expiry" ON "integration_device_authorizations" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_integration_device_authorizations_user" ON "integration_device_authorizations" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "integration_authorization_flow_receipts" ADD CONSTRAINT "integration_auth_receipts_authority_check" CHECK ("integration_authorization_flow_receipts"."authority" in ('local', 'platform_broker'));
--> statement-breakpoint
ALTER TABLE "integration_connection_assignments" DROP CONSTRAINT "integration_connection_assignments_squad_id_provider_key_pk";--> statement-breakpoint
ALTER TABLE "integration_connection_assignments" ADD CONSTRAINT "integration_connection_assignments_squad_id_provider_key_connection_id_pk" PRIMARY KEY("squad_id","provider_key","connection_id");--> statement-breakpoint
ALTER TABLE "integration_connection_assignments" ADD COLUMN "is_default" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_integration_assignments_default" ON "integration_connection_assignments" USING btree ("squad_id","provider_key") WHERE "integration_connection_assignments"."is_default" = true;
--> statement-breakpoint
ALTER TABLE "squad_types" ADD COLUMN "work_styles" jsonb;
--> statement-breakpoint
ALTER TABLE "assistant_conversations" ADD COLUMN "editor" jsonb;
--> statement-breakpoint
ALTER TABLE "agent_types" ADD COLUMN "system_only" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_types" DROP COLUMN "flow_prompt";
--> statement-breakpoint
ALTER TABLE "squad_types" RENAME TO "squad_presets";--> statement-breakpoint
ALTER TABLE "squads" RENAME COLUMN "squad_type_id" TO "squad_preset_id";--> statement-breakpoint
ALTER TABLE "squads" DROP CONSTRAINT "squads_squad_type_id_squad_types_id_fk";
--> statement-breakpoint
ALTER TABLE "squad_presets" DROP COLUMN "worker_instructions";
--> statement-breakpoint
ALTER TABLE "work_stream_flow_runs" RENAME COLUMN "profiles" TO "participant_snapshots";--> statement-breakpoint
ALTER TABLE "work_style_bindings" RENAME COLUMN "profile" TO "agent_snapshot";
--> statement-breakpoint
ALTER TABLE "work_style_bindings" RENAME TO "workflow_bindings";--> statement-breakpoint
ALTER TABLE "work_styles" RENAME TO "workflows";--> statement-breakpoint
ALTER TABLE "squad_presets" RENAME COLUMN "work_styles" TO "workflows";--> statement-breakpoint
ALTER TABLE "workflow_bindings" DROP CONSTRAINT "work_style_bindings_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "workflow_bindings" DROP CONSTRAINT "work_style_bindings_work_stream_id_work_streams_id_fk";
--> statement-breakpoint
DROP INDEX "idx_work_style_binding_key";--> statement-breakpoint
ALTER TABLE "workflow_bindings" ADD CONSTRAINT "workflow_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_bindings" ADD CONSTRAINT "workflow_bindings_work_stream_id_work_streams_id_fk" FOREIGN KEY ("work_stream_id") REFERENCES "public"."work_streams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workflow_binding_key" ON "workflow_bindings" USING btree ("work_stream_id","binding_key");
--> statement-breakpoint
ALTER TABLE "work_streams" ADD COLUMN "assigned_reviewer_ids" uuid[] DEFAULT '{}' NOT NULL;
