ALTER TYPE "public"."execution_status" ADD VALUE 'waiting-sandbox' BEFORE 'running';--> statement-breakpoint
CREATE TABLE "sandbox_provision_recoveries" (
	"execution_id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"work_stream_id" uuid,
	"scope" varchar(64) NOT NULL,
	"sandbox_key" varchar(200) NOT NULL,
	"circuit_version" integer,
	"refusal_id" uuid NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"status" varchar(20) DEFAULT 'waiting' NOT NULL,
	"error_code" varchar(64) NOT NULL,
	"reason_code" varchar(64),
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"lease_owner" varchar(200),
	"lease_expires_at" timestamp with time zone,
	"claim_kind" varchar(20),
	"last_error_code" varchar(80),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sandbox_provision_recoveries" ADD CONSTRAINT "sandbox_provision_recoveries_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_provision_recoveries" ADD CONSTRAINT "sandbox_provision_recoveries_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_provision_recoveries" ADD CONSTRAINT "sandbox_provision_recoveries_work_stream_id_work_streams_id_fk" FOREIGN KEY ("work_stream_id") REFERENCES "public"."work_streams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_sandbox_provision_recoveries_due" ON "sandbox_provision_recoveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "idx_sandbox_provision_recoveries_scope_due" ON "sandbox_provision_recoveries" USING btree ("scope","status","next_attempt_at");