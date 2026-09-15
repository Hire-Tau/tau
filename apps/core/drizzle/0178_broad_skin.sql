CREATE TABLE "work_stream_worktrees" (
	"work_stream_id" uuid PRIMARY KEY NOT NULL,
	"squad_id" uuid NOT NULL,
	"ownership" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worktree_cleanup_jobs" (
	"work_stream_id" uuid PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"generation" uuid DEFAULT gen_random_uuid() NOT NULL,
	"reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"delivered_head" text,
	"delivery_metadata" jsonb,
	"operation_id" uuid,
	"removal_input" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "work_streams" ADD COLUMN "auto_cleanup_worktree" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "work_stream_worktrees" ADD CONSTRAINT "work_stream_worktrees_work_stream_id_work_streams_id_fk" FOREIGN KEY ("work_stream_id") REFERENCES "public"."work_streams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_stream_worktrees" ADD CONSTRAINT "work_stream_worktrees_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worktree_cleanup_jobs" ADD CONSTRAINT "worktree_cleanup_jobs_work_stream_id_work_streams_id_fk" FOREIGN KEY ("work_stream_id") REFERENCES "public"."work_streams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_owned_worktree_path" ON "work_stream_worktrees" USING btree ("squad_id",("ownership"->>'worktree'));--> statement-breakpoint
CREATE INDEX "idx_worktree_cleanup_due" ON "worktree_cleanup_jobs" USING btree ("status","next_attempt_at");