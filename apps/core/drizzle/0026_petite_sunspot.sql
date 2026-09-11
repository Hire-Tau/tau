CREATE TABLE "squad_source_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"squad_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "squad_source_configs_squad_id_source_type_unique" UNIQUE("squad_id","source_type")
);
--> statement-breakpoint
ALTER TABLE "squad_source_configs" ADD CONSTRAINT "squad_source_configs_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;