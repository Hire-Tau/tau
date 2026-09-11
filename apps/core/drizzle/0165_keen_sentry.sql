CREATE TABLE "integration_authorization_flow_receipts" (
	"local_flow_id" uuid PRIMARY KEY NOT NULL,
	"provider_key" varchar(64) NOT NULL,
	"authority" varchar(32) NOT NULL,
	"intent" varchar(16) NOT NULL,
	"initiating_user_id" uuid NOT NULL,
	"return_to" varchar(1024) NOT NULL,
	"completion_handle_hash" varchar(64) NOT NULL,
	"adapter_version" integer,
	"source_connection_id" uuid,
	"source_material_revision" uuid,
	"artifact_credential_ref" varchar(255) NOT NULL,
	"staging_started_at" timestamp with time zone,
	"install_kind" varchar(32),
	"installed_connection_id" uuid,
	"installed_material_revision" uuid,
	"installed_at" timestamp with time zone,
	"terminal_code" varchar(64),
	"terminal_at" timestamp with time zone,
	"revocation_required_at" timestamp with time zone,
	"revocation_settled_at" timestamp with time zone,
	"cleanup_required_at" timestamp with time zone,
	"cleanup_settled_at" timestamp with time zone,
	"recovery_expires_at" timestamp with time zone NOT NULL,
	"retain_until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_authorization_flow_receipts_artifact_credential_ref_unique" UNIQUE("artifact_credential_ref"),
	CONSTRAINT "integration_auth_receipts_authority_check" CHECK ("integration_authorization_flow_receipts"."authority" = 'platform_broker'),
	CONSTRAINT "integration_auth_receipts_artifact_ref_binding" CHECK ("integration_authorization_flow_receipts"."artifact_credential_ref" = '__integration-credential:authorization-flow:' || "integration_authorization_flow_receipts"."local_flow_id"::text || ':bearer'),
	CONSTRAINT "integration_auth_receipts_intent_check" CHECK ("integration_authorization_flow_receipts"."intent" in ('connect', 'reconnect')),
	CONSTRAINT "integration_auth_receipts_handle_hash_format" CHECK ("integration_authorization_flow_receipts"."completion_handle_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "integration_auth_receipts_adapter_version_positive" CHECK ("integration_authorization_flow_receipts"."adapter_version" IS NULL OR "integration_authorization_flow_receipts"."adapter_version" > 0),
	CONSTRAINT "integration_auth_receipts_intent_context" CHECK (("integration_authorization_flow_receipts"."intent" = 'connect' AND "integration_authorization_flow_receipts"."source_connection_id" IS NULL AND "integration_authorization_flow_receipts"."source_material_revision" IS NULL) OR ("integration_authorization_flow_receipts"."intent" = 'reconnect' AND "integration_authorization_flow_receipts"."source_connection_id" IS NOT NULL AND "integration_authorization_flow_receipts"."source_material_revision" IS NOT NULL)),
	CONSTRAINT "integration_auth_receipts_terminal_pair" CHECK (("integration_authorization_flow_receipts"."terminal_code" IS NULL) = ("integration_authorization_flow_receipts"."terminal_at" IS NULL)),
	CONSTRAINT "integration_auth_receipts_terminal_code_format" CHECK ("integration_authorization_flow_receipts"."terminal_code" IS NULL OR "integration_authorization_flow_receipts"."terminal_code" ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
	CONSTRAINT "integration_auth_receipts_install_kind_check" CHECK ("integration_authorization_flow_receipts"."install_kind" IS NULL OR "integration_authorization_flow_receipts"."install_kind" in ('connect', 'reconnect_same', 'reconnect_distinct')),
	CONSTRAINT "integration_auth_receipts_staging_tuple" CHECK (("integration_authorization_flow_receipts"."staging_started_at" IS NULL) = ("integration_authorization_flow_receipts"."adapter_version" IS NULL)),
	CONSTRAINT "integration_auth_receipts_install_tuple" CHECK (("integration_authorization_flow_receipts"."install_kind" IS NULL AND "integration_authorization_flow_receipts"."installed_connection_id" IS NULL AND "integration_authorization_flow_receipts"."installed_material_revision" IS NULL AND "integration_authorization_flow_receipts"."installed_at" IS NULL) OR ("integration_authorization_flow_receipts"."install_kind" IS NOT NULL AND "integration_authorization_flow_receipts"."installed_connection_id" IS NOT NULL AND "integration_authorization_flow_receipts"."installed_material_revision" IS NOT NULL AND "integration_authorization_flow_receipts"."installed_at" IS NOT NULL AND "integration_authorization_flow_receipts"."staging_started_at" IS NOT NULL AND "integration_authorization_flow_receipts"."adapter_version" IS NOT NULL)),
	CONSTRAINT "integration_auth_receipts_install_intent" CHECK ("integration_authorization_flow_receipts"."install_kind" IS NULL OR ("integration_authorization_flow_receipts"."intent" = 'connect' AND "integration_authorization_flow_receipts"."install_kind" = 'connect') OR ("integration_authorization_flow_receipts"."intent" = 'reconnect' AND "integration_authorization_flow_receipts"."install_kind" in ('reconnect_same', 'reconnect_distinct'))),
	CONSTRAINT "integration_auth_receipts_install_terminal_exclusive" CHECK ("integration_authorization_flow_receipts"."terminal_at" IS NULL OR "integration_authorization_flow_receipts"."installed_at" IS NULL),
	CONSTRAINT "integration_auth_receipts_revocation_settlement" CHECK ("integration_authorization_flow_receipts"."revocation_settled_at" IS NULL OR ("integration_authorization_flow_receipts"."revocation_required_at" IS NOT NULL AND "integration_authorization_flow_receipts"."revocation_settled_at" >= "integration_authorization_flow_receipts"."revocation_required_at")),
	CONSTRAINT "integration_auth_receipts_cleanup_settlement" CHECK ("integration_authorization_flow_receipts"."cleanup_settled_at" IS NULL OR ("integration_authorization_flow_receipts"."cleanup_required_at" IS NOT NULL AND "integration_authorization_flow_receipts"."cleanup_settled_at" >= "integration_authorization_flow_receipts"."cleanup_required_at")),
	CONSTRAINT "integration_auth_receipts_obligation_disposition" CHECK (("integration_authorization_flow_receipts"."revocation_required_at" IS NULL AND "integration_authorization_flow_receipts"."cleanup_required_at" IS NULL) OR "integration_authorization_flow_receipts"."terminal_at" IS NOT NULL OR "integration_authorization_flow_receipts"."installed_at" IS NOT NULL),
	CONSTRAINT "integration_auth_receipts_retention_window" CHECK ("integration_authorization_flow_receipts"."retain_until" >= "integration_authorization_flow_receipts"."recovery_expires_at")
);
--> statement-breakpoint
ALTER TABLE "integration_credential_cleanup_jobs" DROP CONSTRAINT "integration_credential_cleanup_jobs_credential_ref_secrets_key_fk";
--> statement-breakpoint
DROP INDEX "idx_integration_revocation_jobs_due";--> statement-breakpoint
ALTER TABLE "integration_connections" ADD COLUMN "client_authority" varchar(32) DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD COLUMN "authorization_flow_id" uuid;--> statement-breakpoint
ALTER TABLE "integration_credential_cleanup_jobs" ADD COLUMN "authorization_flow_id" uuid;--> statement-breakpoint
ALTER TABLE "integration_oauth_states" ADD COLUMN "local_flow_id" uuid;--> statement-breakpoint
ALTER TABLE "integration_oauth_states" ADD COLUMN "authority" varchar(32) DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_oauth_states" ADD COLUMN "completion_handle_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "integration_oauth_states" ADD COLUMN "recovery_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "integration_revocation_jobs" ADD COLUMN "client_authority" varchar(32) DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_revocation_jobs" ADD COLUMN "authorization_flow_id" uuid;--> statement-breakpoint
ALTER TABLE "integration_revocation_jobs" ADD COLUMN "terminal_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_integration_auth_receipts_recovery" ON "integration_authorization_flow_receipts" USING btree ("recovery_expires_at","local_flow_id") WHERE "integration_authorization_flow_receipts"."installed_at" IS NULL AND "integration_authorization_flow_receipts"."terminal_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_integration_auth_receipts_revocation" ON "integration_authorization_flow_receipts" USING btree ("revocation_required_at","local_flow_id") WHERE "integration_authorization_flow_receipts"."revocation_required_at" IS NOT NULL AND "integration_authorization_flow_receipts"."revocation_settled_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_integration_auth_receipts_cleanup" ON "integration_authorization_flow_receipts" USING btree ("cleanup_required_at","local_flow_id") WHERE "integration_authorization_flow_receipts"."cleanup_required_at" IS NOT NULL AND "integration_authorization_flow_receipts"."cleanup_settled_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_integration_auth_receipts_retention" ON "integration_authorization_flow_receipts" USING btree ("retain_until","local_flow_id");--> statement-breakpoint
ALTER TABLE "integration_credential_cleanup_jobs" ADD CONSTRAINT "integration_credential_cleanup_jobs_authorization_flow_id_integration_authorization_flow_receipts_local_flow_id_fk" FOREIGN KEY ("authorization_flow_id") REFERENCES "public"."integration_authorization_flow_receipts"("local_flow_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_credential_cleanup_jobs" ADD CONSTRAINT "integration_credential_cleanup_jobs_credential_ref_secrets_key_fk" FOREIGN KEY ("credential_ref") REFERENCES "public"."secrets"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_revocation_jobs" ADD CONSTRAINT "integration_revocation_jobs_authorization_flow_id_integration_authorization_flow_receipts_local_flow_id_fk" FOREIGN KEY ("authorization_flow_id") REFERENCES "public"."integration_authorization_flow_receipts"("local_flow_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_integration_connections_authorization_flow" ON "integration_connections" USING btree ("authorization_flow_id") WHERE "integration_connections"."authorization_flow_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_integration_credential_cleanup_flow" ON "integration_credential_cleanup_jobs" USING btree ("authorization_flow_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_integration_oauth_states_local_flow" ON "integration_oauth_states" USING btree ("local_flow_id") WHERE "integration_oauth_states"."local_flow_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_integration_revocation_jobs_flow" ON "integration_revocation_jobs" USING btree ("authorization_flow_id");--> statement-breakpoint
CREATE INDEX "idx_integration_revocation_jobs_due" ON "integration_revocation_jobs" USING btree ("next_attempt_at","lease_expires_at") WHERE "integration_revocation_jobs"."terminal_at" IS NULL;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_client_authority_check" CHECK ("integration_connections"."client_authority" in ('local', 'platform_broker'));--> statement-breakpoint
ALTER TABLE "integration_oauth_states" ADD CONSTRAINT "integration_oauth_states_authority_check" CHECK ("integration_oauth_states"."authority" in ('local', 'platform_broker'));--> statement-breakpoint
ALTER TABLE "integration_oauth_states" ADD CONSTRAINT "integration_oauth_states_completion_claim_pair" CHECK (("integration_oauth_states"."completion_handle_hash" IS NULL) = ("integration_oauth_states"."recovery_expires_at" IS NULL));--> statement-breakpoint
ALTER TABLE "integration_oauth_states" ADD CONSTRAINT "integration_oauth_states_completion_hash_format" CHECK ("integration_oauth_states"."completion_handle_hash" IS NULL OR "integration_oauth_states"."completion_handle_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "integration_oauth_states" ADD CONSTRAINT "integration_oauth_states_authority_flow_check" CHECK (("integration_oauth_states"."authority" = 'local' AND "integration_oauth_states"."local_flow_id" IS NULL) OR ("integration_oauth_states"."authority" = 'platform_broker' AND "integration_oauth_states"."local_flow_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "integration_revocation_jobs" ADD CONSTRAINT "integration_revocation_jobs_client_authority_check" CHECK ("integration_revocation_jobs"."client_authority" in ('local', 'platform_broker'));