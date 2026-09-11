CREATE TABLE "stored_secret_tool_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"secret_key" text NOT NULL,
	"outcome" varchar(24) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stored_secret_tool_audits_outcome_valid" CHECK ("stored_secret_tool_audits"."outcome" IN ('denied', 'already_executed'))
);
--> statement-breakpoint
CREATE INDEX "idx_stored_secret_tool_audits_execution_created" ON "stored_secret_tool_audits" USING btree ("execution_id","created_at");