CREATE TYPE "public"."agent_file_attachment_status" AS ENUM('uploading', 'pending', 'used');--> statement-breakpoint
CREATE TABLE "agent_file_attachments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"sandbox_id" text NOT NULL,
	"uploaded_by_type" varchar(32) NOT NULL,
	"uploaded_by_id" varchar(200) NOT NULL,
	"original_name" varchar(500) NOT NULL,
	"stored_name" varchar(255) NOT NULL,
	"private_path" text NOT NULL,
	"content_type" varchar(255) NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"status" "agent_file_attachment_status" DEFAULT 'pending' NOT NULL,
	"upload_attempt_id" uuid,
	"used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_agent_file_attachments" (
	"message_id" uuid NOT NULL,
	"attachment_id" uuid NOT NULL,
	CONSTRAINT "message_agent_file_attachments_message_id_attachment_id_pk" PRIMARY KEY("message_id","attachment_id")
);
--> statement-breakpoint
ALTER TABLE "images" ADD COLUMN "uploaded_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_file_attachments" ADD CONSTRAINT "agent_file_attachments_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_agent_file_attachments" ADD CONSTRAINT "message_agent_file_attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_agent_file_attachments" ADD CONSTRAINT "message_agent_file_attachments_attachment_id_agent_file_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."agent_file_attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_file_attachments_agent" ON "agent_file_attachments" USING btree ("agent_id");--> statement-breakpoint
ALTER TABLE "images" ADD CONSTRAINT "images_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;