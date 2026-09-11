CREATE TYPE "public"."integration_auth_state" AS ENUM('pending', 'authenticated', 'invalid');--> statement-breakpoint
CREATE TYPE "public"."integration_export_batch_state" AS ENUM('pending', 'processing', 'retry_wait', 'delivered', 'dead_letter', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."integration_health_state" AS ENUM('unknown', 'healthy', 'degraded', 'unreachable');--> statement-breakpoint
CREATE TABLE "integration_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid,
	"squad_id" uuid NOT NULL,
	"agent_id" uuid,
	"user_id" uuid,
	"capability" varchar(64),
	"action" varchar(64) NOT NULL,
	"outcome" varchar(32) NOT NULL,
	"request_id" uuid,
	"idempotency_key" uuid,
	"record_count" integer,
	"byte_count" integer,
	"code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"squad_id" uuid NOT NULL,
	"provider_key" varchar(64) NOT NULL,
	"adapter_version" integer NOT NULL,
	"display_name" varchar(200) NOT NULL,
	"configuration" jsonb NOT NULL,
	"credential_ref" varchar(255) NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"auth_state" "integration_auth_state" DEFAULT 'pending' NOT NULL,
	"health_state" "integration_health_state" DEFAULT 'unknown' NOT NULL,
	"granted_scopes" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"material_revision" uuid DEFAULT gen_random_uuid() NOT NULL,
	"validated_revision" uuid,
	"validated_at" timestamp with time zone,
	"validation_expires_at" timestamp with time zone,
	"health_checked_at" timestamp with time zone,
	"last_healthy_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"next_validation_at" timestamp with time zone,
	"validation_failure_count" integer DEFAULT 0 NOT NULL,
	"last_error_code" varchar(64),
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_export_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cursor_id" uuid NOT NULL,
	"idempotency_key" uuid DEFAULT gen_random_uuid() NOT NULL,
	"first_enqueue_order" bigint NOT NULL,
	"last_enqueue_order" bigint NOT NULL,
	"record_count" integer NOT NULL,
	"byte_count" integer NOT NULL,
	"encrypted_payload" text,
	"payload_iv" text,
	"state" "integration_export_batch_state" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error_code" varchar(64),
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_integration_export_batches_idempotency" UNIQUE("idempotency_key"),
	CONSTRAINT "uq_integration_export_batches_cursor_first_order" UNIQUE("cursor_id","first_enqueue_order")
);
--> statement-breakpoint
CREATE TABLE "integration_export_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"consented_by_user_id" uuid NOT NULL,
	"consented_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"policy_version" integer DEFAULT 1 NOT NULL,
	"projection_version" integer DEFAULT 1 NOT NULL,
	"adopted_enqueue_order" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_export_cursors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"consent_id" uuid NOT NULL,
	"last_delivered_enqueue_order" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_export_cursors_consent_id_unique" UNIQUE("consent_id")
);
--> statement-breakpoint
ALTER TABLE "agent_types" ADD COLUMN "integration_capabilities" jsonb;--> statement-breakpoint
ALTER TABLE "integration_audit_events" ADD CONSTRAINT "integration_audit_events_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_audit_events" ADD CONSTRAINT "integration_audit_events_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_audit_events" ADD CONSTRAINT "integration_audit_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_audit_events" ADD CONSTRAINT "integration_audit_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_export_batches" ADD CONSTRAINT "integration_export_batches_cursor_id_integration_export_cursors_id_fk" FOREIGN KEY ("cursor_id") REFERENCES "public"."integration_export_cursors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_export_consents" ADD CONSTRAINT "integration_export_consents_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_export_consents" ADD CONSTRAINT "integration_export_consents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_export_consents" ADD CONSTRAINT "integration_export_consents_consented_by_user_id_users_id_fk" FOREIGN KEY ("consented_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_export_cursors" ADD CONSTRAINT "integration_export_cursors_consent_id_integration_export_consents_id_fk" FOREIGN KEY ("consent_id") REFERENCES "public"."integration_export_consents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_integration_audit_events_squad_created" ON "integration_audit_events" USING btree ("squad_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_integration_connections_squad_provider" ON "integration_connections" USING btree ("squad_id","provider_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_integration_connections_enabled_provider" ON "integration_connections" USING btree ("squad_id","provider_key") WHERE "integration_connections"."enabled" = true;--> statement-breakpoint
CREATE INDEX "idx_integration_connections_revalidation" ON "integration_connections" USING btree ("next_validation_at") WHERE "integration_connections"."enabled" = true;--> statement-breakpoint
CREATE INDEX "idx_integration_export_batches_due" ON "integration_export_batches" USING btree ("next_attempt_at","state");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_integration_export_consents_active_agent" ON "integration_export_consents" USING btree ("agent_id") WHERE "integration_export_consents"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_integration_export_consents_connection" ON "integration_export_consents" USING btree ("connection_id");