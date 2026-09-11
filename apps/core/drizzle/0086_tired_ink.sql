CREATE TABLE "device_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_code_hash" text NOT NULL,
	"verification_code_hash" text NOT NULL,
	"user_id" uuid,
	"name" varchar(200) NOT NULL,
	"platform" varchar(20) DEFAULT 'cli' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"approved_at" timestamp,
	"consumed_at" timestamp,
	"last_polled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "device_authorizations_device_code_hash_unique" UNIQUE("device_code_hash"),
	CONSTRAINT "device_authorizations_verification_code_hash_unique" UNIQUE("verification_code_hash")
);
--> statement-breakpoint
ALTER TABLE "device_authorizations" ADD CONSTRAINT "device_authorizations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_device_authorizations_expires" ON "device_authorizations" USING btree ("expires_at");