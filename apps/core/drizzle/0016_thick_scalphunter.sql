ALTER TABLE "app_deployments" ADD COLUMN "name" varchar(100) DEFAULT 'deployment' NOT NULL;--> statement-breakpoint
ALTER TABLE "app_deployments" ADD COLUMN "provider_project_url" text;