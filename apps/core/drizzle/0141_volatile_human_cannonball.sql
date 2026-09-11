CREATE TABLE "live_activity_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"apns_token" text NOT NULL,
	"kind" varchar(20) NOT NULL,
	"activity_id" text,
	"environment" varchar(20) DEFAULT 'production' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp,
	CONSTRAINT "live_activity_tokens_apns_token_unique" UNIQUE("apns_token")
);
--> statement-breakpoint
ALTER TABLE "live_activity_tokens" ADD CONSTRAINT "live_activity_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;