CREATE TABLE "sandbox_toolchain_provisions" (
	"sandbox_id" varchar(255) PRIMARY KEY NOT NULL,
	"squad_id" uuid NOT NULL,
	"desired_fingerprint" varchar(64) NOT NULL,
	"applied_fingerprint" varchar(64),
	"status" varchar(32) NOT NULL,
	"error_code" varchar(64),
	"exit_code" integer,
	"started_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "sandbox_toolchain_provisions" ADD CONSTRAINT "sandbox_toolchain_provisions_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sandbox_toolchain_provisions_squad_idx" ON "sandbox_toolchain_provisions" USING btree ("squad_id");