ALTER TABLE "agent_types" ALTER COLUMN "model" SET DATA TYPE varchar(500);--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "model_override" SET DATA TYPE varchar(500);