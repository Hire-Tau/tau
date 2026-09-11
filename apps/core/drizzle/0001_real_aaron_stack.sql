CREATE TABLE "notification_config" (
	"id" varchar(50) PRIMARY KEY NOT NULL,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"channels" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" varchar(20) DEFAULT 'yaml' NOT NULL,
	"yaml_drift" boolean DEFAULT false NOT NULL,
	"yaml_template" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_types" ADD COLUMN "updated_by" varchar(20) DEFAULT 'yaml' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_types" ADD COLUMN "yaml_drift" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_types" ADD COLUMN "yaml_template" jsonb;--> statement-breakpoint
ALTER TABLE "channel_instances" ADD COLUMN "updated_by" varchar(20) DEFAULT 'yaml' NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_instances" ADD COLUMN "yaml_drift" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_instances" ADD COLUMN "yaml_template" jsonb;--> statement-breakpoint
ALTER TABLE "squad_types" ADD COLUMN "updated_by" varchar(20) DEFAULT 'yaml' NOT NULL;--> statement-breakpoint
ALTER TABLE "squad_types" ADD COLUMN "yaml_drift" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "squad_types" ADD COLUMN "yaml_template" jsonb;