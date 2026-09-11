ALTER TABLE "machines" ADD COLUMN "artifact_versions" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
-- Backfill: machines that already carry a pushed server bundle record it under
-- the generic per-artifact map so the first generic ensure does not re-push.
-- server_bundle_version itself is kept (still read) until the server-bundle
-- path is converted to artifact_versions.
UPDATE machines SET artifact_versions = jsonb_build_object('server', server_bundle_version) WHERE server_bundle_version IS NOT NULL;
