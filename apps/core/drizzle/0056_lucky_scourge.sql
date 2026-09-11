ALTER TABLE "messages" ADD COLUMN "injected_at" timestamp;--> statement-breakpoint
UPDATE "messages" SET "injected_at" = now()
WHERE "pending" = true AND "metadata"->>'sessionDeliveryAttemptedAt' IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_messages_pending_uninjected" ON "messages" USING btree ("agent_id","created_at") WHERE "messages"."pending" = true AND "messages"."injected_at" IS NULL;
