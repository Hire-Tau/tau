CREATE TABLE "devbox_lock_cache" (
	"seed_hash" text PRIMARY KEY NOT NULL,
	"lock_content" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
