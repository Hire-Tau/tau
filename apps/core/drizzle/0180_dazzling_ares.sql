ALTER TABLE "worktree_cleanup_jobs" ADD COLUMN "delivered_head" text;--> statement-breakpoint
ALTER TABLE "worktree_cleanup_jobs" ADD COLUMN "delivery_metadata" jsonb;