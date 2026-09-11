CREATE TYPE "public"."app_deployment_cost_risk" AS ENUM('none', 'low', 'metered', 'paid_required');--> statement-breakpoint
CREATE TYPE "public"."app_deployment_environment" AS ENUM('preview', 'production');--> statement-breakpoint
CREATE TYPE "public"."app_deployment_status" AS ENUM('planned', 'deploying', 'ready', 'failed', 'rolled_back', 'destroyed');--> statement-breakpoint
CREATE TYPE "public"."sandbox_preview_mode" AS ENUM('managed', 'attached');--> statement-breakpoint
CREATE TYPE "public"."sandbox_preview_restart_policy" AS ENUM('always', 'never');--> statement-breakpoint
CREATE TYPE "public"."sandbox_preview_status" AS ENUM('starting', 'running', 'restarting', 'unhealthy', 'crashed', 'stopped');--> statement-breakpoint
CREATE TYPE "public"."sandbox_preview_visibility" AS ENUM('private', 'public');--> statement-breakpoint
CREATE TABLE "app_deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"squad_id" uuid NOT NULL,
	"provider" varchar(100) NOT NULL,
	"external_project_id" text,
	"url" text,
	"environment" "app_deployment_environment" DEFAULT 'preview' NOT NULL,
	"status" "app_deployment_status" DEFAULT 'planned' NOT NULL,
	"cost_risk" "app_deployment_cost_risk" DEFAULT 'none' NOT NULL,
	"logs_command" text,
	"rollback_command" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_agent_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandbox_previews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"squad_id" uuid NOT NULL,
	"sandbox_id" varchar(255) NOT NULL,
	"name" varchar(100) NOT NULL,
	"port" integer NOT NULL,
	"target_host" varchar(255) NOT NULL,
	"url_path_or_host" text NOT NULL,
	"visibility" "sandbox_preview_visibility" DEFAULT 'private' NOT NULL,
	"mode" "sandbox_preview_mode" DEFAULT 'managed' NOT NULL,
	"status" "sandbox_preview_status" DEFAULT 'starting' NOT NULL,
	"keep_sandbox_alive" boolean DEFAULT true NOT NULL,
	"command" text,
	"cwd" text,
	"env_secret_refs" text[],
	"process_id" varchar(255),
	"restart_policy" "sandbox_preview_restart_policy" DEFAULT 'always' NOT NULL,
	"restart_count" integer DEFAULT 0 NOT NULL,
	"created_by_agent_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "app_deployments" ADD CONSTRAINT "app_deployments_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_deployments" ADD CONSTRAINT "app_deployments_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_previews" ADD CONSTRAINT "sandbox_previews_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_previews" ADD CONSTRAINT "sandbox_previews_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_deployments_squad_idx" ON "app_deployments" USING btree ("squad_id");--> statement-breakpoint
CREATE INDEX "app_deployments_provider_idx" ON "app_deployments" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "sandbox_previews_squad_idx" ON "sandbox_previews" USING btree ("squad_id");--> statement-breakpoint
CREATE INDEX "sandbox_previews_status_idx" ON "sandbox_previews" USING btree ("status");