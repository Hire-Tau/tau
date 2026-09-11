ALTER TABLE "machines" ADD COLUMN "auto_provisioned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "empty_since" timestamp with time zone;--> statement-breakpoint
-- Backfill: legacy pre-packer squad/commons VMs were auto-provisioned by the old
-- placement (exe-sq-<squadId> / exe-commons), so mark them reap-eligible — once
-- their boxes' owners terminate and the rows drain, the empty-machine reaper
-- reclaims them. User-registered machines (BYO ssh, operator exe-provisions,
-- which only ever carry purpose 'shared'/'dedicated') are untouched.
UPDATE "machines" SET "auto_provisioned" = true WHERE "provider" = 'exe' AND "purpose" IN ('squad', 'commons');
