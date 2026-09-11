CREATE TYPE "public"."delivery_mode" AS ENUM('steer', 'follow-up');--> statement-breakpoint
ALTER TYPE "public"."inbox_message_sender_type" ADD VALUE 'voice_assistant';--> statement-breakpoint
ALTER TABLE "inbox" ADD COLUMN "delivery_mode" "delivery_mode" DEFAULT 'follow-up' NOT NULL;--> statement-breakpoint
ALTER TABLE "inbox" ADD COLUMN "delivery_attempted_at" timestamp;--> statement-breakpoint
ALTER TABLE "inbox" ADD COLUMN "delivery_error" text;