ALTER TABLE "inbox" ADD COLUMN "idempotency_key" varchar(200);--> statement-breakpoint
ALTER TABLE "inbox" ADD CONSTRAINT "inbox_idempotency_key_unique" UNIQUE("idempotency_key");