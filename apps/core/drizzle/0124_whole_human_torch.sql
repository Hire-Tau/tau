CREATE TABLE "integration_event_polling_cursors" (
	"provider_key" varchar(100) NOT NULL,
	"resource_key" text NOT NULL,
	"cursor" jsonb,
	"next_poll_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_event_polling_cursors_provider_key_resource_key_pk" PRIMARY KEY("provider_key","resource_key")
);
--> statement-breakpoint
CREATE INDEX "idx_integration_event_polling_due" ON "integration_event_polling_cursors" USING btree ("next_poll_at","lease_until");