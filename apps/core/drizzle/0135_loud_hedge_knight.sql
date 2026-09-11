CREATE TABLE "integration_connection_assignments" (
	"squad_id" uuid NOT NULL,
	"provider_key" varchar(64) NOT NULL,
	"connection_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_connection_assignments_squad_id_provider_key_pk" PRIMARY KEY("squad_id","provider_key")
);
--> statement-breakpoint
ALTER TABLE "integration_audit_events" DROP CONSTRAINT "integration_audit_events_squad_id_squads_id_fk";
--> statement-breakpoint
ALTER TABLE "integration_connections" DROP CONSTRAINT "integration_connections_squad_id_squads_id_fk";
--> statement-breakpoint
DROP INDEX "idx_integration_connections_squad_provider";--> statement-breakpoint
DROP INDEX "uq_integration_connections_enabled_provider";--> statement-breakpoint
ALTER TABLE "integration_audit_events" ALTER COLUMN "squad_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_connections" ALTER COLUMN "squad_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "uq_integration_connections_id_provider" UNIQUE("id","provider_key");--> statement-breakpoint
ALTER TABLE "integration_connection_assignments" ADD CONSTRAINT "integration_connection_assignments_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connection_assignments" ADD CONSTRAINT "integration_connection_assignments_connection_provider_fk" FOREIGN KEY ("connection_id","provider_key") REFERENCES "public"."integration_connections"("id","provider_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_integration_connection_assignments_connection" ON "integration_connection_assignments" USING btree ("connection_id","squad_id");--> statement-breakpoint
ALTER TABLE "integration_audit_events" ADD CONSTRAINT "integration_audit_events_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
WITH duplicates AS (
	SELECT id
	FROM (
		SELECT id, count(*) OVER (PARTITION BY provider_key, display_name) AS copies
		FROM integration_connections
	) ranked
	WHERE copies > 1
)
UPDATE integration_connections AS connection
SET display_name = left(connection.display_name, 120) || ' (' ||
	left(squads.name, 32) || ' ' || left(connection.id::text, 8) || ')'
FROM squads, duplicates
WHERE connection.id = duplicates.id AND squads.id = connection.squad_id;--> statement-breakpoint
INSERT INTO integration_connection_assignments (squad_id, provider_key, connection_id)
SELECT squad_id, provider_key, id
FROM integration_connections
WHERE squad_id IS NOT NULL AND enabled = true
ON CONFLICT (squad_id, provider_key) DO NOTHING;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_integration_connections_provider_display_name" ON "integration_connections" USING btree ("provider_key","display_name");
--> statement-breakpoint
CREATE TABLE "integration_credential_cleanup_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credential_ref" varchar(255) NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"last_error_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_credential_cleanup_jobs_credential_ref_unique" UNIQUE("credential_ref"),
	CONSTRAINT "integration_credential_cleanup_lease_pair" CHECK (("integration_credential_cleanup_jobs"."lease_token" IS NULL) = ("integration_credential_cleanup_jobs"."lease_expires_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "integration_credential_cleanup_jobs" ADD CONSTRAINT "integration_credential_cleanup_jobs_credential_ref_secrets_key_fk" FOREIGN KEY ("credential_ref") REFERENCES "public"."secrets"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_integration_credential_cleanup_due" ON "integration_credential_cleanup_jobs" USING btree ("next_attempt_at","lease_expires_at");