CREATE TABLE "integration_event_polling_dispatches" (
	"provider_key" varchar(100) NOT NULL,
	"event_key" text NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_event_polling_dispatches_provider_key_event_key_pk" PRIMARY KEY("provider_key","event_key")
);
--> statement-breakpoint
CREATE INDEX "idx_integration_event_polling_dispatch_lease" ON "integration_event_polling_dispatches" USING btree ("completed_at","lease_until");