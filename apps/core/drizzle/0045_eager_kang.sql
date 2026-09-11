CREATE TABLE "system_inbox_reads" (
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"read_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "system_inbox_reads_message_id_user_id_pk" PRIMARY KEY("message_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "work_streams" ADD COLUMN "requesting_user_id" uuid;--> statement-breakpoint
ALTER TABLE "system_inbox_reads" ADD CONSTRAINT "system_inbox_reads_message_id_inbox_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."inbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_inbox_reads" ADD CONSTRAINT "system_inbox_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_streams" ADD CONSTRAINT "work_streams_requesting_user_id_users_id_fk" FOREIGN KEY ("requesting_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Recreate the inbox sender/recipient enums to rename 'human' -> 'user' and add 'system'.
-- We recreate the type (rather than RENAME VALUE + ADD VALUE) because drizzle's migrator runs every
-- pending migration in a SINGLE transaction, and Postgres forbids using an ADD VALUE'd enum value in
-- the same transaction. A freshly CREATE'd type's values are usable immediately, so the data relabel
-- below can run in the same transaction.
ALTER TYPE "public"."inbox_message_sender_type" RENAME TO "inbox_message_sender_type_old";--> statement-breakpoint
CREATE TYPE "public"."inbox_message_sender_type" AS ENUM('system', 'agent', 'user', 'voice_assistant');--> statement-breakpoint
ALTER TABLE "inbox" ALTER COLUMN "sender_type" TYPE "public"."inbox_message_sender_type" USING (CASE "sender_type"::text WHEN 'human' THEN 'user' ELSE "sender_type"::text END::"public"."inbox_message_sender_type");--> statement-breakpoint
DROP TYPE "public"."inbox_message_sender_type_old";--> statement-breakpoint
ALTER TYPE "public"."inbox_recipient_type" RENAME TO "inbox_recipient_type_old";--> statement-breakpoint
CREATE TYPE "public"."inbox_recipient_type" AS ENUM('agent', 'user', 'voice_assistant', 'system');--> statement-breakpoint
ALTER TABLE "inbox" ALTER COLUMN "recipient_type" TYPE "public"."inbox_recipient_type" USING (CASE "recipient_type"::text WHEN 'human' THEN 'user' ELSE "recipient_type"::text END::"public"."inbox_recipient_type");--> statement-breakpoint
DROP TYPE "public"."inbox_recipient_type_old";--> statement-breakpoint
-- Relabel the old shared human singleton inbox (recipient_type 'human'->'user', recipient_id 'user')
-- to the new shared system inbox. Existing history becomes shared announcements, not personal mail.
UPDATE "inbox" SET "recipient_type" = 'system', "recipient_id" = 'system' WHERE "recipient_type" = 'user' AND "recipient_id" = 'user';--> statement-breakpoint
-- Remove the legacy bare-'workspace' voice scratch inbox rows. The voice workspace assistant is now a
-- per-user identity ('workspace:<userId>'); these ephemeral singleton rows have no owner.
DELETE FROM "inbox" WHERE "recipient_type" = 'voice_assistant' AND "recipient_id" = 'workspace';
