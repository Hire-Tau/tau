CREATE TYPE "public"."chat_send_receipt_state" AS ENUM('pending', 'accepted');--> statement-breakpoint
CREATE TABLE "chat_send_receipts" (
	"agent_id" uuid NOT NULL,
	"client_id" varchar(128) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"state" "chat_send_receipt_state" DEFAULT 'pending' NOT NULL,
	"message_id" uuid,
	"execution_id" uuid,
	"disposition" varchar(24),
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_send_receipts_agent_id_client_id_pk" PRIMARY KEY("agent_id","client_id")
);
--> statement-breakpoint
CREATE TABLE "execution_admission_reservations" (
	"execution_id" uuid PRIMARY KEY NOT NULL,
	"maintenance_state_id" varchar(32) DEFAULT 'global' NOT NULL,
	"token" uuid NOT NULL,
	"claim_epoch" bigint NOT NULL,
	"owner_id" varchar(200) NOT NULL,
	"owner_incarnation" uuid NOT NULL,
	"admitted_generation" integer NOT NULL,
	"admitted_holder_revision" bigint NOT NULL,
	"state" varchar(32) NOT NULL,
	"phase" varchar(48) DEFAULT 'none' NOT NULL,
	"phase_sequence" integer DEFAULT 0 NOT NULL,
	"operation_id" varchar(255),
	"resource_key" varchar(255),
	"lease_expires_at" timestamp with time zone NOT NULL,
	"revoke_generation" integer,
	"revoke_holder_revision" bigint,
	"revoke_admin_hold" boolean,
	"revoke_lease_id" uuid,
	"revoke_lease_owner_token_id" uuid,
	"revoke_requested_at" timestamp with time zone,
	"recovery_owner_id" varchar(200),
	"recovery_owner_incarnation" uuid,
	"last_heartbeat_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_admission_reservations_token_unique" UNIQUE("token"),
	CONSTRAINT "execution_admission_reservation_epoch_positive" CHECK ("execution_admission_reservations"."claim_epoch" > 0)
);
--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "maintenance_generation" integer;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "maintenance_queued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "runner_claim_token" uuid;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "runner_claim_generation" integer;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "execution_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "instance_maintenance_state" ADD COLUMN "holder_revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_send_receipts" ADD CONSTRAINT "chat_send_receipts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_send_receipts" ADD CONSTRAINT "chat_send_receipts_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_send_receipts" ADD CONSTRAINT "chat_send_receipts_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_admission_reservations" ADD CONSTRAINT "execution_admission_reservations_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_execution_admission_reservations_state_expiry" ON "execution_admission_reservations" USING btree ("state","lease_expires_at");--> statement-breakpoint
CREATE INDEX "idx_execution_admission_reservations_owner" ON "execution_admission_reservations" USING btree ("owner_id","owner_incarnation","state");