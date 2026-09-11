CREATE TABLE "box_condemnation_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sandbox_id" text NOT NULL,
	"generation" integer NOT NULL,
	"machine_id" uuid NOT NULL,
	"classification" text NOT NULL,
	"probes" jsonb NOT NULL,
	"machine_snapshot" jsonb NOT NULL,
	"active_execution" boolean,
	"grace_budget_ms" integer NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_box_condemnation_evidence_generation_unique" ON "box_condemnation_evidence" USING btree ("sandbox_id","generation");--> statement-breakpoint
CREATE INDEX "idx_box_condemnation_evidence_recorded" ON "box_condemnation_evidence" USING btree ("sandbox_id","recorded_at");