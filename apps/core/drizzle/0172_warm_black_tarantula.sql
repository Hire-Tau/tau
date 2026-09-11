CREATE TABLE "shared_prompts" (
	"id" varchar(100) PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text,
	"content" text NOT NULL,
	"yaml_template" jsonb,
	"yaml_field_overrides" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_types" ADD COLUMN "includes" text[] DEFAULT '{}' NOT NULL;