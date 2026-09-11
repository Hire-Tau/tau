CREATE TABLE "fleet_incident_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"kind" varchar(20) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"claim_token" uuid,
	"claimed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"inbox_message_id" uuid,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fleet_incident_notifications_incident_id_kind_unique" UNIQUE("incident_id","kind"),
	CONSTRAINT "fleet_incident_notifications_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "fleet_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" varchar(40) NOT NULL,
	"scope_key" varchar(255) NOT NULL,
	"squad_id" uuid,
	"provider" varchar(100),
	"account_id" varchar(100),
	"health_kind" varchar(40),
	"provider_retry_at" timestamp with time zone,
	"provider_last_success_at" timestamp with time zone,
	"started_at" timestamp with time zone NOT NULL,
	"alert_after" timestamp with time zone NOT NULL,
	"last_observed_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"cause_code" varchar(80) NOT NULL,
	"cause_summary" text NOT NULL,
	"remediation" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "run_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fleet_incident_notifications" ADD CONSTRAINT "fleet_incident_notifications_incident_id_fleet_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."fleet_incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_incident_notifications" ADD CONSTRAINT "fleet_incident_notifications_inbox_message_id_inbox_id_fk" FOREIGN KEY ("inbox_message_id") REFERENCES "public"."inbox"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_incidents" ADD CONSTRAINT "fleet_incidents_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_fleet_incident_notifications_due" ON "fleet_incident_notifications" USING btree ("status","claimed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_fleet_incidents_one_open_scope" ON "fleet_incidents" USING btree ("kind","scope_key") WHERE "fleet_incidents"."resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_fleet_incidents_alert_due" ON "fleet_incidents" USING btree ("resolved_at","alert_after");