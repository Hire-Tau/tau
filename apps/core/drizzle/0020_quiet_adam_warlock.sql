CREATE TABLE "global_secret_exposures" (
	"secret_key" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "global_secret_exposures_secret_key_unique" UNIQUE("secret_key")
);
--> statement-breakpoint
CREATE INDEX "global_secret_exposures_secret_key_idx" ON "global_secret_exposures" USING btree ("secret_key");