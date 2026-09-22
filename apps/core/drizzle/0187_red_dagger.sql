CREATE TABLE "desktop_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"event_key" text NOT NULL,
	"event_type" text NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "desktop_notifications" ADD CONSTRAINT "desktop_notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_desktop_notifications_event" ON "desktop_notifications" USING btree ("user_id","event_key");--> statement-breakpoint
CREATE INDEX "idx_desktop_notifications_recent" ON "desktop_notifications" USING btree ("user_id","created_at");