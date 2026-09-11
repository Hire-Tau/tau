CREATE TABLE "model_tiers" (
	"slug" varchar(100) PRIMARY KEY NOT NULL,
	"label" varchar(200) NOT NULL,
	"description" text,
	"chain" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"yaml_template" jsonb,
	"yaml_field_overrides" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_types" ADD COLUMN "tier" varchar(100);
--> statement-breakpoint
UPDATE "agent_types" SET
 "tier" = CASE
   WHEN "id" IN ('subagent','artifact-builder-default','general') THEN 'fast'
   WHEN "id" IN ('engineer','concierge','consultant') THEN 'standard'
   WHEN "id" IN ('reviewer','architect','manager','system-manager','sysops') THEN 'deep'
   WHEN "id" = 'security-auditor' THEN 'exhaustive'
   ELSE "tier"
 END,
 "model" = CASE WHEN "id" IN ('subagent','artifact-builder-default','general','engineer','concierge','consultant','reviewer','architect','manager','system-manager','sysops','security-auditor') AND NOT ("yaml_field_overrides" ? 'model') THEN '' ELSE "model" END;
