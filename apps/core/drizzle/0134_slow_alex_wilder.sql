CREATE TABLE "vm_box_setup_states" (
	"sandbox_id" text PRIMARY KEY NOT NULL,
	"desired_fingerprint" varchar(64) NOT NULL,
	"readiness" varchar(24) NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"pending_invocation_id" text,
	"pending_invocation_kind" varchar(40),
	"last_failure_class" varchar(64),
	"last_attempt_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vm_box_setup_states" ADD CONSTRAINT "vm_box_setup_states_sandbox_id_machine_boxes_sandbox_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."machine_boxes"("sandbox_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_vm_box_setup_states_due" ON "vm_box_setup_states" USING btree ("readiness","next_attempt_at");