CREATE TABLE "agent_question_recipients" (
	"question_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"reason" varchar(32) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_question_recipients_question_id_user_id_pk" PRIMARY KEY("question_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "agent_question_work_stream_origins" (
	"question_id" uuid NOT NULL,
	"work_stream_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_question_work_stream_origins_question_id_work_stream_id_pk" PRIMARY KEY("question_id","work_stream_id")
);
--> statement-breakpoint
ALTER TABLE "agent_questions" ADD COLUMN "execution_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD COLUMN "audience_resolution" varchar(32);--> statement-breakpoint
ALTER TABLE "agent_questions" ADD COLUMN "audience_resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD COLUMN "audience_alerted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_question_recipients" ADD CONSTRAINT "agent_question_recipients_question_id_agent_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."agent_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_question_recipients" ADD CONSTRAINT "agent_question_recipients_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_question_work_stream_origins" ADD CONSTRAINT "agent_question_work_stream_origins_question_id_agent_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."agent_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_question_work_stream_origins" ADD CONSTRAINT "agent_question_work_stream_origins_work_stream_id_work_streams_id_fk" FOREIGN KEY ("work_stream_id") REFERENCES "public"."work_streams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_question_recipients_user_question" ON "agent_question_recipients" USING btree ("user_id","question_id");--> statement-breakpoint
CREATE INDEX "idx_agent_question_origins_stream_question" ON "agent_question_work_stream_origins" USING btree ("work_stream_id","question_id");--> statement-breakpoint
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE set null ON UPDATE no action;