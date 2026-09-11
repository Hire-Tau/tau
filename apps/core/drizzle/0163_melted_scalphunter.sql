ALTER TABLE "agent_questions" ALTER COLUMN "dismissal_reason" SET DATA TYPE varchar(256);--> statement-breakpoint
ALTER TABLE "agent_questions" ADD COLUMN "dismissed_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD COLUMN "dismissed_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_dismissed_by_user_id_users_id_fk" FOREIGN KEY ("dismissed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_dismissed_by_agent_id_agents_id_fk" FOREIGN KEY ("dismissed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;