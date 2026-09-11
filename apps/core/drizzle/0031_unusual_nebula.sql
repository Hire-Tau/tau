CREATE TYPE "public"."monitor_status" AS ENUM('starting', 'running', 'canceling', 'exited', 'canceled', 'timed-out', 'failed');--> statement-breakpoint
CREATE TABLE "monitors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"sandbox_id" varchar(200) NOT NULL,
	"label" varchar(200) NOT NULL,
	"description" text,
	"command" text NOT NULL,
	"cwd" varchar(500),
	"status" "monitor_status" DEFAULT 'starting' NOT NULL,
	"process_id" varchar(200) NOT NULL,
	"timeout_ms" integer NOT NULL,
	"max_batch_lines" integer NOT NULL,
	"max_batch_bytes" integer NOT NULL,
	"batch_debounce_ms" integer NOT NULL,
	"delivery_mode" "delivery_mode" DEFAULT 'follow-up' NOT NULL,
	"exit_code" integer,
	"last_batch_at" timestamp,
	"lines_emitted" integer DEFAULT 0 NOT NULL,
	"bytes_emitted" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"ended_at" timestamp,
	"failure_reason" text
);
--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_monitors_agent_status" ON "monitors" USING btree ("agent_id","status");