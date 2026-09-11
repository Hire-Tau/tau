ALTER TABLE "agent_types" ADD COLUMN "yaml_field_overrides" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_instances" ADD COLUMN "yaml_field_overrides" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_config" ADD COLUMN "yaml_field_overrides" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "yaml_field_overrides" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "squad_types" ADD COLUMN "yaml_field_overrides" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_types" DROP COLUMN "updated_by";--> statement-breakpoint
ALTER TABLE "agent_types" DROP COLUMN "yaml_drift";--> statement-breakpoint
ALTER TABLE "channel_instances" DROP COLUMN "updated_by";--> statement-breakpoint
ALTER TABLE "channel_instances" DROP COLUMN "yaml_drift";--> statement-breakpoint
ALTER TABLE "notification_config" DROP COLUMN "updated_by";--> statement-breakpoint
ALTER TABLE "notification_config" DROP COLUMN "yaml_drift";--> statement-breakpoint
ALTER TABLE "skills" DROP COLUMN "updated_by";--> statement-breakpoint
ALTER TABLE "skills" DROP COLUMN "yaml_drift";--> statement-breakpoint
ALTER TABLE "squad_types" DROP COLUMN "updated_by";--> statement-breakpoint
ALTER TABLE "squad_types" DROP COLUMN "yaml_drift";