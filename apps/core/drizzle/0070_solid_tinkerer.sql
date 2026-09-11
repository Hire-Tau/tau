CREATE TABLE "remote_host_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host_id" uuid NOT NULL,
	"squad_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "remote_host_grants_host_id_squad_id_unique" UNIQUE("host_id","squad_id")
);
--> statement-breakpoint
CREATE TABLE "remote_hosts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"ssh_host" text NOT NULL,
	"ssh_port" integer DEFAULT 22 NOT NULL,
	"ssh_user" text NOT NULL,
	"ssh_key_id" text NOT NULL,
	"ssh_public_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "remote_hosts_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "remote_host_grants" ADD CONSTRAINT "remote_host_grants_host_id_remote_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."remote_hosts"("id") ON DELETE cascade ON UPDATE no action;