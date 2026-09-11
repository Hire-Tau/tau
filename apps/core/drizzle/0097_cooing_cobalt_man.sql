CREATE TABLE "sandbox_toolchain_activations" (
	"sandbox_id" varchar(255) PRIMARY KEY NOT NULL,
	"squad_id" uuid NOT NULL,
	"applied_fingerprint" varchar(64),
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sandbox_toolchain_activations" ADD CONSTRAINT "sandbox_toolchain_activations_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sandbox_toolchain_activations_squad_idx" ON "sandbox_toolchain_activations" USING btree ("squad_id");--> statement-breakpoint
CREATE INDEX "sandbox_toolchain_activations_updated_idx" ON "sandbox_toolchain_activations" USING btree ("updated_at","sandbox_id");--> statement-breakpoint
CREATE INDEX "sandbox_toolchain_provisions_terminal_cleanup_idx" ON "sandbox_toolchain_provisions" USING btree ("completed_at","sandbox_id") WHERE "sandbox_toolchain_provisions"."status" in ('ready', 'failed');--> statement-breakpoint
CREATE INDEX "sandbox_toolchain_provisions_orphan_cleanup_idx" ON "sandbox_toolchain_provisions" USING btree ("updated_at","sandbox_id");