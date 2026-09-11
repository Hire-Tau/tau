ALTER TABLE "fleet_incident_notifications" DROP CONSTRAINT "fleet_incident_notifications_incident_id_kind_unique";--> statement-breakpoint
DROP INDEX "idx_fleet_incident_notifications_due";--> statement-breakpoint
ALTER TABLE "fleet_incident_notifications" ALTER COLUMN "idempotency_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "fleet_incident_notifications" ADD COLUMN "audience" varchar(20) DEFAULT 'human' NOT NULL;--> statement-breakpoint
ALTER TABLE "fleet_incident_notifications" ADD COLUMN "recipient_id" varchar(200) DEFAULT 'system';--> statement-breakpoint
ALTER TABLE "fleet_incident_notifications" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_fleet_incident_notifications_due" ON "fleet_incident_notifications" USING btree ("status","next_attempt_at","claimed_at");--> statement-breakpoint
ALTER TABLE "fleet_incident_notifications" ADD CONSTRAINT "fleet_incident_notifications_incident_id_kind_audience_unique" UNIQUE("incident_id","kind","audience");