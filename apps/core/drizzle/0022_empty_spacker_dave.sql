CREATE TABLE "skills" (
	"id" varchar(100) PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text,
	"content" text NOT NULL,
	"support_files" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" varchar(20) DEFAULT 'yaml' NOT NULL,
	"yaml_drift" boolean DEFAULT false NOT NULL,
	"yaml_template" jsonb,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
