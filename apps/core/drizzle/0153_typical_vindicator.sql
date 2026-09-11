CREATE TYPE "public"."execution_failure_class" AS ENUM('provider_transport', 'provider_model', 'platform_pre_tool_refusal', 'execution_failure');--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "failure_class" "execution_failure_class";--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "failure_reason" varchar(64);