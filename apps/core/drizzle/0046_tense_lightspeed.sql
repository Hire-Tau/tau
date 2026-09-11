CREATE TABLE "user_notification_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"push_enabled" boolean DEFAULT true NOT NULL,
	"muted_events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_stream_subscriptions" (
	"work_stream_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "work_stream_subscriptions_work_stream_id_user_id_pk" PRIMARY KEY("work_stream_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "user_notification_preferences" ADD CONSTRAINT "user_notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_stream_subscriptions" ADD CONSTRAINT "work_stream_subscriptions_work_stream_id_work_streams_id_fk" FOREIGN KEY ("work_stream_id") REFERENCES "public"."work_streams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_stream_subscriptions" ADD CONSTRAINT "work_stream_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;