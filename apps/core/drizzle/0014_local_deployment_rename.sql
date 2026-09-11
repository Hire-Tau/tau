ALTER TABLE "sandbox_previews" RENAME TO "local_deployments";
--> statement-breakpoint
ALTER TYPE "sandbox_preview_visibility" RENAME TO "local_deployment_visibility";
--> statement-breakpoint
ALTER TYPE "sandbox_preview_mode" RENAME TO "local_deployment_mode";
--> statement-breakpoint
ALTER TYPE "sandbox_preview_status" RENAME TO "local_deployment_status";
--> statement-breakpoint
ALTER TYPE "sandbox_preview_restart_policy" RENAME TO "local_deployment_restart_policy";
--> statement-breakpoint
ALTER INDEX "sandbox_previews_squad_idx" RENAME TO "local_deployments_squad_idx";
--> statement-breakpoint
ALTER INDEX "sandbox_previews_status_idx" RENAME TO "local_deployments_status_idx";
