CREATE TYPE "public"."squad_activity_access_scope" AS ENUM('agents', 'workstreams', 'inbox', 'workstreams_inbox');--> statement-breakpoint
CREATE TABLE "squad_activity" (
	"squad_id" uuid NOT NULL,
	"lane" integer NOT NULL,
	"row_id" uuid NOT NULL,
	"source_family" varchar(32) NOT NULL,
	"source_group_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"agent_id" uuid,
	"work_stream_id" uuid,
	"agent_type_id" varchar(100),
	"agent_type_requires_agents_read" boolean DEFAULT false NOT NULL,
	"kind" varchar(32) NOT NULL,
	"summary" varchar(512) NOT NULL,
	"ref" jsonb NOT NULL,
	"quiet_eligible" boolean NOT NULL,
	"access_scope" "squad_activity_access_scope" NOT NULL,
	"inbox_recipient_id" uuid,
	"payload_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "squad_activity_squad_id_lane_row_id_pk" PRIMARY KEY("squad_id","lane","row_id"),
	CONSTRAINT "squad_activity_lane_check" CHECK ("squad_activity"."lane" IN (10,20,30,31,40,41,50,60,61,70)),
	CONSTRAINT "squad_activity_lane_kind_check" CHECK (("squad_activity"."lane"=10 AND "squad_activity"."kind"='message') OR ("squad_activity"."lane"=20 AND "squad_activity"."kind"='message') OR ("squad_activity"."lane"=30 AND "squad_activity"."kind"='workstream') OR ("squad_activity"."lane"=31 AND "squad_activity"."kind"='workstream') OR ("squad_activity"."lane"=40 AND "squad_activity"."kind"='wait') OR ("squad_activity"."lane"=41 AND "squad_activity"."kind"='wait') OR ("squad_activity"."lane"=50 AND "squad_activity"."kind"='handoff') OR ("squad_activity"."lane"=60 AND "squad_activity"."kind"='execution') OR ("squad_activity"."lane"=61 AND "squad_activity"."kind"='execution') OR ("squad_activity"."lane"=70 AND "squad_activity"."kind"='pr')),
	CONSTRAINT "squad_activity_lane_scope_check" CHECK (("squad_activity"."lane"=10 AND "squad_activity"."access_scope"='agents') OR ("squad_activity"."lane"=20 AND "squad_activity"."access_scope"='inbox') OR ("squad_activity"."lane"=30 AND "squad_activity"."access_scope"='workstreams') OR ("squad_activity"."lane"=31 AND "squad_activity"."access_scope"='workstreams_inbox') OR ("squad_activity"."lane"=40 AND "squad_activity"."access_scope"='workstreams') OR ("squad_activity"."lane"=41 AND "squad_activity"."access_scope"='workstreams') OR ("squad_activity"."lane"=50 AND "squad_activity"."access_scope"='workstreams_inbox') OR ("squad_activity"."lane"=60 AND "squad_activity"."access_scope"='agents') OR ("squad_activity"."lane"=61 AND "squad_activity"."access_scope"='agents') OR ("squad_activity"."lane"=70 AND "squad_activity"."access_scope"='workstreams')),
	CONSTRAINT "squad_activity_recipient_check" CHECK (("squad_activity"."inbox_recipient_id" IS NOT NULL) = ("squad_activity"."access_scope" IN ('inbox','workstreams_inbox')))
);
--> statement-breakpoint
CREATE TABLE "squad_activity_maintenance_leases" (
	"task" varchar(64) PRIMARY KEY NOT NULL,
	"lease_token" uuid NOT NULL,
	"lease_until" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integration_event_polling_dispatches" ADD COLUMN "activity_id" uuid;--> statement-breakpoint
ALTER TABLE "integration_event_polling_dispatches" ADD COLUMN "event_fact" jsonb;--> statement-breakpoint
ALTER TABLE "integration_event_polling_dispatches" ADD COLUMN "event_occurred_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_squad_activity_source_group" ON "squad_activity" USING btree ("source_family","source_group_id");--> statement-breakpoint
CREATE INDEX "idx_squad_activity_source_window" ON "squad_activity" USING btree ("source_family","at","source_group_id");--> statement-breakpoint
CREATE INDEX "idx_squad_activity_work_stream" ON "squad_activity" USING btree ("work_stream_id");--> statement-breakpoint
CREATE INDEX "idx_squad_activity_feed" ON "squad_activity" USING btree ("squad_id","at" DESC NULLS LAST,"lane" DESC NULLS LAST,"row_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_squad_activity_kind" ON "squad_activity" USING btree ("squad_id","kind","at" DESC NULLS LAST,"lane" DESC NULLS LAST,"row_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_squad_activity_agent" ON "squad_activity" USING btree ("squad_id","agent_id","at" DESC NULLS LAST,"lane" DESC NULLS LAST,"row_id" DESC NULLS LAST) WHERE "squad_activity"."agent_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_squad_activity_inbox" ON "squad_activity" USING btree ("squad_id","inbox_recipient_id","at" DESC NULLS LAST,"lane" DESC NULLS LAST,"row_id" DESC NULLS LAST) WHERE "squad_activity"."inbox_recipient_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_squad_activity_prune" ON "squad_activity" USING btree ("at","squad_id","lane","row_id");