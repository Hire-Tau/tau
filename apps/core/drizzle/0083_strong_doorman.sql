CREATE TABLE "k8s_provision_attempts" (
	"scope" varchar(64) NOT NULL,
	"sandbox_key" varchar(255) NOT NULL,
	"operation_kind" varchar(16) NOT NULL,
	"desired_spec_hash" varchar(64) NOT NULL,
	"attempt_id" uuid NOT NULL,
	"owner_id" varchar(255) NOT NULL,
	"status" varchar(16) NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"pod_name" varchar(253),
	"result_spec_hash" varchar(64),
	"failure_code" varchar(64),
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "k8s_provision_attempts_scope_sandbox_key_pk" PRIMARY KEY("scope","sandbox_key")
);
--> statement-breakpoint
CREATE TABLE "k8s_provision_controls" (
	"scope" varchar(64) PRIMARY KEY NOT NULL,
	"state" varchar(16) DEFAULT 'closed' NOT NULL,
	"failures" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reason_code" varchar(64),
	"retry_at" timestamp with time zone,
	"probe_attempt_id" uuid,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_k8s_provision_attempts_live" ON "k8s_provision_attempts" USING btree ("scope","status","lease_expires_at");