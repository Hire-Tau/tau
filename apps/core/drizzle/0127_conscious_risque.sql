CREATE TYPE "public"."schedule_attempt_source" AS ENUM('scheduled', 'manual', 'webhook');--> statement-breakpoint
CREATE TYPE "public"."schedule_failure_class" AS ENUM('permanent', 'transient');--> statement-breakpoint
CREATE TYPE "public"."schedule_health_event_kind" AS ENUM('failed', 'recovered', 'automatically_disabled');--> statement-breakpoint
CREATE TYPE "public"."schedule_health_notification_kind" AS ENUM('failure', 'permanent_failure', 'disabled', 'recovery');--> statement-breakpoint
CREATE TYPE "public"."schedule_health_notification_status" AS ENUM('pending', 'delivering', 'delivered');--> statement-breakpoint
CREATE TABLE "schedule_health_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid NOT NULL,
	"attempt_id" uuid,
	"incident_id" uuid NOT NULL,
	"kind" "schedule_health_event_kind" NOT NULL,
	"occurred_at" timestamp NOT NULL,
	"failure_class" "schedule_failure_class",
	"error_code" varchar(64),
	"error_summary" varchar(500),
	"consecutive_failure_count" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_health_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"kind" "schedule_health_notification_kind" NOT NULL,
	"squad_id" uuid,
	"idempotency_key" varchar(200) NOT NULL,
	"status" "schedule_health_notification_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"claim_token" uuid,
	"claimed_at" timestamp,
	"inbox_message_id" uuid,
	"delivered_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_health_notifications_incident_id_kind_unique" UNIQUE("incident_id","kind"),
	CONSTRAINT "schedule_health_notifications_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "last_success_at" timestamp;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "last_failure_at" timestamp;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "last_recovered_at" timestamp;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "failure_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "consecutive_failure_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "last_error_code" varchar(64);--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "last_error_summary" varchar(500);--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "automatically_disabled_at" timestamp;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "automatic_disable_reason" varchar(500);--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "open_failure_incident_id" uuid;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "active_attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "active_attempt_source" "schedule_attempt_source";--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "active_attempt_started_at" timestamp;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "active_attempt_lease_until" timestamp;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "system_key" varchar(200);--> statement-breakpoint
ALTER TABLE "schedule_health_events" ADD CONSTRAINT "schedule_health_events_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_health_notifications" ADD CONSTRAINT "schedule_health_notifications_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_health_notifications" ADD CONSTRAINT "schedule_health_notifications_event_id_schedule_health_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."schedule_health_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_health_notifications" ADD CONSTRAINT "schedule_health_notifications_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_health_notifications" ADD CONSTRAINT "schedule_health_notifications_inbox_message_id_inbox_id_fk" FOREIGN KEY ("inbox_message_id") REFERENCES "public"."inbox"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_schedule_health_events_schedule_occurred" ON "schedule_health_events" USING btree ("schedule_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_schedule_health_events_schedule_attempt" ON "schedule_health_events" USING btree ("schedule_id","attempt_id");--> statement-breakpoint
CREATE INDEX "idx_schedule_health_notifications_due" ON "schedule_health_notifications" USING btree ("status","next_attempt_at");--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_system_key_unique" UNIQUE("system_key");