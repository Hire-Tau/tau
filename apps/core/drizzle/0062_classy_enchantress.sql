CREATE TYPE "public"."amtp_outbox_status" AS ENUM('pending', 'delivering', 'delivered', 'failed');--> statement-breakpoint
ALTER TYPE "public"."inbox_message_sender_type" ADD VALUE 'remote';--> statement-breakpoint
CREATE TABLE "amtp_allow_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_agent_id" uuid NOT NULL,
	"peer_instance_id" varchar(64) NOT NULL,
	"principal_kind" varchar(20) NOT NULL,
	"principal_value" varchar(200),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "amtp_known_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"peer_instance_id" varchar(64) NOT NULL,
	"handle" varchar(200) NOT NULL,
	"public_key" text NOT NULL,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "amtp_known_keys_peer_instance_id_handle_unique" UNIQUE("peer_instance_id","handle")
);
--> statement-breakpoint
CREATE TABLE "amtp_received" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"peer_instance_id" varchar(64) NOT NULL,
	"envelope_id" varchar(200) NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "amtp_received_peer_instance_id_envelope_id_unique" UNIQUE("peer_instance_id","envelope_id")
);
--> statement-breakpoint
CREATE TABLE "inbox_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"filename" varchar(500) NOT NULL,
	"content_type" varchar(255) NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"storage_path" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instance_identity" (
	"id" varchar(20) PRIMARY KEY NOT NULL,
	"instance_id" varchar(64) NOT NULL,
	"public_key_pem" text NOT NULL,
	"private_key_pem" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "instance_identity_instance_id_unique" UNIQUE("instance_id")
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"peer_instance_id" varchar(64) NOT NULL,
	"to_address" text NOT NULL,
	"envelope_json" jsonb NOT NULL,
	"idempotency_key" varchar(200) NOT NULL,
	"status" "amtp_outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"last_error" text,
	"claim_token" varchar(64),
	"claimed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "peers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"local_alias" varchar(200) NOT NULL,
	"instance_id" varchar(64) NOT NULL,
	"base_url" text NOT NULL,
	"public_key_pem" text NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "peers_local_alias_unique" UNIQUE("local_alias"),
	CONSTRAINT "peers_instance_id_unique" UNIQUE("instance_id")
);
--> statement-breakpoint
ALTER TABLE "agent_types" ADD COLUMN "extra_scopes" text[];--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "amtp_handle" varchar(200);--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "identity_public_key" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "inbound_open" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "amtp_allow_rules" ADD CONSTRAINT "amtp_allow_rules_target_agent_id_agents_id_fk" FOREIGN KEY ("target_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_attachments" ADD CONSTRAINT "inbox_attachments_message_id_inbox_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."inbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_amtp_allow_rules_target_peer" ON "amtp_allow_rules" USING btree ("target_agent_id","peer_instance_id");--> statement-breakpoint
CREATE INDEX "idx_inbox_attachments_message" ON "inbox_attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "outbox_status_next_attempt_idx" ON "outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_amtp_handle_unique" UNIQUE("amtp_handle");