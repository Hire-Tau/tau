CREATE TABLE "channel_identity_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"instance_id" varchar(100) NOT NULL,
	"identity_scope" text NOT NULL,
	"external_user_id" text NOT NULL,
	"external_user_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_link_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"instance_id" varchar(100),
	"identity_scope" text,
	"external_user_id" text,
	"external_user_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_link_challenges_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "channel_instances" ADD COLUMN "trusted_channel_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_identity_links" ADD CONSTRAINT "channel_identity_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_identity_links" ADD CONSTRAINT "channel_identity_links_instance_id_channel_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."channel_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_link_challenges" ADD CONSTRAINT "channel_link_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_link_challenges" ADD CONSTRAINT "channel_link_challenges_instance_id_channel_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."channel_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_identity_sender_unique" ON "channel_identity_links" USING btree ("instance_id","external_user_id");