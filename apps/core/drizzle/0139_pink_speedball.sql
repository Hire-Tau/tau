ALTER TABLE "agent_questions" ADD COLUMN "dismissed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD COLUMN "dismissal_reason" varchar(64);--> statement-breakpoint
ALTER TABLE "agent_questions" ADD COLUMN "answer_delivery_status" varchar(16);--> statement-breakpoint
ALTER TABLE "agent_questions" ADD COLUMN "answer_delivery_generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD COLUMN "answer_delivery_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD COLUMN "answer_delivery_next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD COLUMN "answer_delivery_claim_token" uuid;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD COLUMN "answer_delivery_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD COLUMN "answer_delivery_last_error" text;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD COLUMN "answer_delivery_inbox_message_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD COLUMN "answer_delivery_message_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD COLUMN "answer_delivery_execution_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD COLUMN "answer_delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "work_stream_waits" ADD COLUMN "created_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_answer_delivery_inbox_message_id_inbox_id_fk" FOREIGN KEY ("answer_delivery_inbox_message_id") REFERENCES "public"."inbox"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_answer_delivery_message_id_messages_id_fk" FOREIGN KEY ("answer_delivery_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_answer_delivery_execution_id_executions_id_fk" FOREIGN KEY ("answer_delivery_execution_id") REFERENCES "public"."executions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_stream_waits" ADD CONSTRAINT "work_stream_waits_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_questions_answer_delivery_due" ON "agent_questions" USING btree ("answer_delivery_next_attempt_at") WHERE "agent_questions"."answer_delivery_status" IN ('pending', 'delivering');