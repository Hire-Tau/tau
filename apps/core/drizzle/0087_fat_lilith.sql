CREATE TABLE "forced_box_migration_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"actor_type" varchar(16) NOT NULL,
	"actor_id" varchar(255) NOT NULL,
	"reason" varchar(500) NOT NULL,
	"sandbox_id" varchar(255) NOT NULL,
	"squad_id" uuid NOT NULL,
	"source_machine_id" uuid NOT NULL,
	"target_machine_id" uuid NOT NULL,
	"active_execution_count" integer NOT NULL,
	"outcome" varchar(16) NOT NULL,
	"result" jsonb,
	"failure_code" varchar(64),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forced_box_migration_audits_request_unique" UNIQUE("request_id")
);
--> statement-breakpoint
CREATE INDEX "idx_forced_box_migration_audits_sandbox_started" ON "forced_box_migration_audits" USING btree ("sandbox_id","started_at");