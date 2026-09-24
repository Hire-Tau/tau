CREATE TYPE "public"."theme_preset_visibility" AS ENUM('private', 'instance');--> statement-breakpoint
CREATE TABLE "theme_presets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"document" jsonb NOT NULL,
	"visibility" "theme_preset_visibility" DEFAULT 'private' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "theme_presets" ADD CONSTRAINT "theme_presets_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_theme_presets_owner" ON "theme_presets" USING btree ("owner_user_id");