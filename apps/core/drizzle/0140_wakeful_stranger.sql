CREATE TYPE "public"."integration_projection_status" AS ENUM('pending', 'installing', 'ready', 'degraded');--> statement-breakpoint
ALTER TYPE "public"."integration_auth_state" ADD VALUE 'reauthorization_required';--> statement-breakpoint
CREATE TABLE "integration_oauth_states" (
	"state_hash" varchar(64) PRIMARY KEY NOT NULL,
	"provider_key" varchar(64) NOT NULL,
	"user_id" uuid NOT NULL,
	"intent" varchar(16) NOT NULL,
	"connection_id" uuid,
	"expected_material_revision" uuid,
	"redirect_uri" varchar(2048) NOT NULL,
	"return_to" varchar(1024) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_oauth_states_hash_format" CHECK ("integration_oauth_states"."state_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "integration_oauth_states_intent_context" CHECK (("integration_oauth_states"."intent" = 'connect' AND "integration_oauth_states"."connection_id" IS NULL AND "integration_oauth_states"."expected_material_revision" IS NULL) OR ("integration_oauth_states"."intent" = 'reconnect' AND "integration_oauth_states"."connection_id" IS NOT NULL AND "integration_oauth_states"."expected_material_revision" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "integration_projection_states" (
	"squad_id" uuid NOT NULL,
	"provider_key" varchar(64) NOT NULL,
	"generation" bigint DEFAULT 1 NOT NULL,
	"status" "integration_projection_status" DEFAULT 'pending' NOT NULL,
	"desired_fingerprint" varchar(64),
	"applied_fingerprint" varchar(64),
	"desired_credential_revision" bigint,
	"applied_credential_revision" bigint,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"last_error_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_projection_states_squad_id_provider_key_pk" PRIMARY KEY("squad_id","provider_key"),
	CONSTRAINT "integration_projection_states_generation_positive" CHECK ("integration_projection_states"."generation" > 0),
	CONSTRAINT "integration_projection_states_lease_pair" CHECK (("integration_projection_states"."lease_token" IS NULL) = ("integration_projection_states"."lease_expires_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "integration_revocation_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_key" varchar(64) NOT NULL,
	"adapter_version" integer NOT NULL,
	"credential_ref" varchar(255) NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"last_error_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_revocation_jobs_credential_ref_unique" UNIQUE("credential_ref"),
	CONSTRAINT "integration_revocation_jobs_lease_pair" CHECK (("integration_revocation_jobs"."lease_token" IS NULL) = ("integration_revocation_jobs"."lease_expires_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "integration_oauth_states" ADD CONSTRAINT "integration_oauth_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_oauth_states" ADD CONSTRAINT "integration_oauth_states_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_projection_states" ADD CONSTRAINT "integration_projection_states_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_revocation_jobs" ADD CONSTRAINT "integration_revocation_jobs_credential_ref_secrets_key_fk" FOREIGN KEY ("credential_ref") REFERENCES "public"."secrets"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_integration_oauth_states_expiry" ON "integration_oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_integration_projection_states_due" ON "integration_projection_states" USING btree ("next_attempt_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "idx_integration_revocation_jobs_due" ON "integration_revocation_jobs" USING btree ("next_attempt_at","lease_expires_at");