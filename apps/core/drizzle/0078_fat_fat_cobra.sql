ALTER TABLE "email_verifications" ADD COLUMN "token_hash" text;--> statement-breakpoint
ALTER TABLE "email_verifications" ADD COLUMN "purpose" text DEFAULT 'register' NOT NULL;--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "applies_to" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_verifications" ADD CONSTRAINT "email_verifications_token_hash_unique" UNIQUE("token_hash");
--> statement-breakpoint
-- Backfill roles.applies_to by slug. The column default ('user') already covers
-- admin/operator/viewer and every custom role; only the agent-derived roles need
-- flipping. 'agent-override' is listed for completeness — today it is a synthetic
-- role summary built in services/rbac/permissions.ts with no row in this table,
-- so it matches nothing unless one is ever persisted.
UPDATE "roles" SET "applies_to" = 'agent' WHERE "slug" IN ('default-worker', 'default-manager', 'default-concierge', 'agent-override');
--> statement-breakpoint
UPDATE "roles" SET "applies_to" = 'user' WHERE "slug" IN ('admin', 'operator', 'viewer');
