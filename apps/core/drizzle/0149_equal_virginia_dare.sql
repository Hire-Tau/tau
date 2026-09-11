CREATE TYPE "public"."slot_claim_status" AS ENUM('active', 'released', 'expired');--> statement-breakpoint
CREATE TYPE "public"."slot_notification_kind" AS ENUM('granted', 'expired');--> statement-breakpoint
CREATE TYPE "public"."slot_notification_status" AS ENUM('pending', 'delivering', 'delivered');--> statement-breakpoint
CREATE TYPE "public"."slot_waiter_status" AS ENUM('queued', 'granted', 'canceled');--> statement-breakpoint
CREATE SEQUENCE "public"."slot_waiter_enqueue_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "slot_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pool_id" uuid NOT NULL,
	"owner_agent_id" uuid NOT NULL,
	"status" "slot_claim_status" DEFAULT 'active' NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"terminal_reason" varchar(64)
);
--> statement-breakpoint
CREATE TABLE "slot_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pool_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"recipient_agent_id" uuid NOT NULL,
	"kind" "slot_notification_kind" NOT NULL,
	"idempotency_key" varchar(200) NOT NULL,
	"status" "slot_notification_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"claim_token" uuid,
	"inbox_id" uuid,
	"delivered_at" timestamp with time zone,
	"last_error_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slot_notifications_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "slot_notifications_delivery_claim_pair" CHECK (("slot_notifications"."claimed_at" IS NULL) = ("slot_notifications"."claim_token" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "slot_pools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"squad_id" uuid NOT NULL,
	"key" varchar(64) NOT NULL,
	"capacity" integer DEFAULT 1 NOT NULL,
	"claim_timeout_ms" integer DEFAULT 3600000 NOT NULL,
	"created_by" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unregistered_at" timestamp with time zone,
	CONSTRAINT "slot_pools_key_format" CHECK ("slot_pools"."key" ~ '^[a-z][a-z0-9._-]{0,63}$'),
	CONSTRAINT "slot_pools_capacity_positive" CHECK ("slot_pools"."capacity" >= 1),
	CONSTRAINT "slot_pools_claim_timeout_bounds" CHECK ("slot_pools"."claim_timeout_ms" >= 60000 AND "slot_pools"."claim_timeout_ms" <= 86400000)
);
--> statement-breakpoint
CREATE TABLE "slot_waiters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pool_id" uuid NOT NULL,
	"owner_agent_id" uuid NOT NULL,
	"enqueue_sequence" bigint DEFAULT nextval('slot_waiter_enqueue_seq'::regclass) NOT NULL,
	"status" "slot_waiter_status" DEFAULT 'queued' NOT NULL,
	"resulting_claim_id" uuid,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"terminal_reason" varchar(64)
);
--> statement-breakpoint
ALTER TABLE "slot_claims" ADD CONSTRAINT "slot_claims_pool_id_slot_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."slot_pools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_notifications" ADD CONSTRAINT "slot_notifications_pool_id_slot_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."slot_pools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_notifications" ADD CONSTRAINT "slot_notifications_claim_id_slot_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."slot_claims"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_notifications" ADD CONSTRAINT "slot_notifications_inbox_id_inbox_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "public"."inbox"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_pools" ADD CONSTRAINT "slot_pools_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_waiters" ADD CONSTRAINT "slot_waiters_pool_id_slot_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."slot_pools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_waiters" ADD CONSTRAINT "slot_waiters_resulting_claim_id_slot_claims_id_fk" FOREIGN KEY ("resulting_claim_id") REFERENCES "public"."slot_claims"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_slot_claims_active_owner_unique" ON "slot_claims" USING btree ("pool_id","owner_agent_id") WHERE "slot_claims"."status" = 'active';--> statement-breakpoint
CREATE INDEX "idx_slot_claims_due" ON "slot_claims" USING btree ("pool_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "idx_slot_notifications_due" ON "slot_notifications" USING btree ("status","next_attempt_at","claimed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_slot_pools_active_key_unique" ON "slot_pools" USING btree ("squad_id","key") WHERE "slot_pools"."unregistered_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_slot_waiters_queued_owner_unique" ON "slot_waiters" USING btree ("pool_id","owner_agent_id") WHERE "slot_waiters"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "idx_slot_waiters_fifo" ON "slot_waiters" USING btree ("pool_id","enqueue_sequence","id");