CREATE TABLE "machine_boxes" (
	"sandbox_id" text PRIMARY KEY NOT NULL,
	"machine_id" uuid NOT NULL,
	"unix_user" text NOT NULL,
	"port" integer NOT NULL,
	"status" text DEFAULT 'ensuring' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "machines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"provider_ref" text,
	"ssh_host" text NOT NULL,
	"ssh_port" integer DEFAULT 22 NOT NULL,
	"ssh_user" text NOT NULL,
	"ssh_key_id" text NOT NULL,
	"ssh_public_key" text NOT NULL,
	"status" text DEFAULT 'registered' NOT NULL,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scope" text DEFAULT 'shared' NOT NULL,
	"bootstrap_version" text,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "machines_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "machine_boxes" ADD CONSTRAINT "machine_boxes_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;