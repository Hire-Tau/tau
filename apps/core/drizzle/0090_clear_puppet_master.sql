CREATE TABLE "instance_maintenance_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"generation" integer NOT NULL,
	"action" text NOT NULL,
	"actor" text NOT NULL,
	"reason" text,
	"lease_id" uuid,
	"lease_expires_at" timestamp with time zone,
	"admin_hold" boolean NOT NULL,
	"effective" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instance_maintenance_state" (
	"id" varchar(20) PRIMARY KEY NOT NULL,
	"admin_hold" boolean DEFAULT false NOT NULL,
	"admin_reason" text,
	"admin_held_at" timestamp with time zone,
	"admin_held_by" text,
	"platform_lease_id" uuid,
	"platform_lease_owner_token_id" uuid,
	"platform_lease_holder" varchar(200),
	"platform_lease_acquired_at" timestamp with time zone,
	"platform_lease_expires_at" timestamp with time zone,
	"generation" integer DEFAULT 0 NOT NULL,
	"quiesced_generation" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_maintenance_singleton" CHECK ("instance_maintenance_state"."id" = 'global'),
	CONSTRAINT "instance_maintenance_generation_order" CHECK ("instance_maintenance_state"."quiesced_generation" <= "instance_maintenance_state"."generation"),
	CONSTRAINT "instance_maintenance_lease_coherent" CHECK (("instance_maintenance_state"."platform_lease_id" IS NULL AND "instance_maintenance_state"."platform_lease_owner_token_id" IS NULL AND "instance_maintenance_state"."platform_lease_holder" IS NULL AND "instance_maintenance_state"."platform_lease_acquired_at" IS NULL AND "instance_maintenance_state"."platform_lease_expires_at" IS NULL) OR ("instance_maintenance_state"."platform_lease_id" IS NOT NULL AND "instance_maintenance_state"."platform_lease_owner_token_id" IS NOT NULL AND "instance_maintenance_state"."platform_lease_holder" IS NOT NULL AND "instance_maintenance_state"."platform_lease_acquired_at" IS NOT NULL AND "instance_maintenance_state"."platform_lease_expires_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX "idx_instance_maintenance_audit_created_at" ON "instance_maintenance_audit" USING btree ("created_at");