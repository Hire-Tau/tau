CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."agent_status" AS ENUM('idle', 'active', 'waiting-input', 'compacting', 'resetting');--> statement-breakpoint
CREATE TYPE "public"."execution_status" AS ENUM('queued', 'running', 'pausing', 'paused', 'stopping', 'stopped', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."image_status" AS ENUM('pending', 'used', 'failed');--> statement-breakpoint
CREATE TYPE "public"."inbox_message_sender_type" AS ENUM('system', 'agent', 'human');--> statement-breakpoint
CREATE TYPE "public"."inbox_recipient_type" AS ENUM('agent', 'human');--> statement-breakpoint
CREATE TYPE "public"."message_role" AS ENUM('human', 'assistant');--> statement-breakpoint
CREATE TYPE "public"."sandbox_status" AS ENUM('none', 'initializing', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."schedule_scope_type" AS ENUM('squad', 'agent');--> statement-breakpoint
CREATE TYPE "public"."squad_relationship_type" AS ENUM('reports_to', 'collaborates', 'depends_on');--> statement-breakpoint
CREATE TYPE "public"."squad_status" AS ENUM('active', 'paused', 'archived');--> statement-breakpoint
CREATE TYPE "public"."work_stream_status" AS ENUM('pending', 'in_progress', 'blocked', 'review', 'done');--> statement-breakpoint
CREATE TABLE "agent_types" (
	"id" varchar(100) PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text,
	"model" varchar(200) NOT NULL,
	"system_prompt" text NOT NULL,
	"skills" text[],
	"extensions" text[],
	"tools_allow" text[],
	"tools_deny" text[],
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_type_id" varchar(100) NOT NULL,
	"squad_id" uuid,
	"status" "agent_status" DEFAULT 'idle' NOT NULL,
	"persist" boolean DEFAULT false NOT NULL,
	"metadata" jsonb,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"question_data" jsonb,
	"session_usage" jsonb,
	"terminated_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_instances" (
	"id" varchar(100) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"provider" varchar(50) NOT NULL,
	"provider_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"linked_squads" varchar(100)[] DEFAULT '{}' NOT NULL,
	"channel_squad_map" jsonb DEFAULT '{}'::jsonb,
	"default_squad_id" uuid,
	"concierge_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"status" "execution_status" DEFAULT 'queued' NOT NULL,
	"message" text,
	"image_ids" uuid[],
	"usage" jsonb,
	"error" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"filename" varchar(255) NOT NULL,
	"mime_type" varchar(100) NOT NULL,
	"size" integer NOT NULL,
	"agent_id" uuid,
	"status" "image_status" DEFAULT 'pending' NOT NULL,
	"used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient_type" "inbox_recipient_type" NOT NULL,
	"recipient_id" varchar(200) NOT NULL,
	"sender_type" "inbox_message_sender_type" NOT NULL,
	"sender_id" varchar(200),
	"subject" varchar(500),
	"content" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"read_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"squad_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"start_line" integer,
	"end_line" integer,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" vector(1536),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "memory_chunks_document_id_chunk_index_unique" UNIQUE("document_id","chunk_index")
);
--> statement-breakpoint
CREATE TABLE "memory_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"squad_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"title" text,
	"path" text,
	"frontmatter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "memory_documents_squad_id_source_type_source_id_unique" UNIQUE("squad_id","source_type","source_id")
);
--> statement-breakpoint
CREATE TABLE "memory_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"squad_id" uuid NOT NULL,
	"source_document_id" uuid NOT NULL,
	"target_raw" text NOT NULL,
	"target_document_id" uuid,
	"target_heading" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"role" "message_role" NOT NULL,
	"content" text NOT NULL,
	"metadata" jsonb,
	"pending" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_type" "schedule_scope_type" NOT NULL,
	"scope_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"schedule" jsonb NOT NULL,
	"action" jsonb NOT NULL,
	"trigger_count" integer DEFAULT 0 NOT NULL,
	"last_triggered_at" timestamp,
	"next_trigger_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(255) NOT NULL,
	"encrypted_value" text NOT NULL,
	"iv" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now(),
	"updated_by" varchar(100),
	CONSTRAINT "secrets_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "squad_relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_squad_id" uuid NOT NULL,
	"target_squad_id" uuid NOT NULL,
	"relationship_type" "squad_relationship_type" NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "squad_relationships_source_squad_id_target_squad_id_relationship_type_unique" UNIQUE("source_squad_id","target_squad_id","relationship_type")
);
--> statement-breakpoint
CREATE TABLE "squad_types" (
	"id" varchar(100) PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text,
	"purpose" text,
	"default_agents" text[] DEFAULT '{}' NOT NULL,
	"manager_instructions" text,
	"worker_instructions" jsonb,
	"schedule_templates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "squads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(200) NOT NULL,
	"purpose" text NOT NULL,
	"status" "squad_status" DEFAULT 'active' NOT NULL,
	"squad_type_id" varchar(100),
	"default_agents" text[] DEFAULT '{}' NOT NULL,
	"manager_agent_id" uuid,
	"context" text,
	"is_anonymous" boolean DEFAULT false NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sandbox_status" "sandbox_status" DEFAULT 'none' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(50) NOT NULL,
	"event_type" varchar(100) NOT NULL,
	"payload" jsonb NOT NULL,
	"headers" jsonb NOT NULL,
	"signature" text,
	"verified" boolean DEFAULT false NOT NULL,
	"processed_at" timestamp,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_streams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"squad_id" uuid NOT NULL,
	"title" varchar(500) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" "work_stream_status" DEFAULT 'pending' NOT NULL,
	"assignee_agent_id" uuid,
	"agent_ids" uuid[],
	"depends_on" uuid[] DEFAULT '{}' NOT NULL,
	"blocked_prompt" jsonb,
	"review_prompt" jsonb,
	"handoff_message" text,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"response" jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_instances" ADD CONSTRAINT "channel_instances_default_squad_id_squads_id_fk" FOREIGN KEY ("default_squad_id") REFERENCES "public"."squads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_instances" ADD CONSTRAINT "channel_instances_concierge_agent_id_agents_id_fk" FOREIGN KEY ("concierge_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "images" ADD CONSTRAINT "images_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_chunks" ADD CONSTRAINT "memory_chunks_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_chunks" ADD CONSTRAINT "memory_chunks_document_id_memory_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."memory_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_documents" ADD CONSTRAINT "memory_documents_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_links" ADD CONSTRAINT "memory_links_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_links" ADD CONSTRAINT "memory_links_source_document_id_memory_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."memory_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_links" ADD CONSTRAINT "memory_links_target_document_id_memory_documents_id_fk" FOREIGN KEY ("target_document_id") REFERENCES "public"."memory_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "squad_relationships" ADD CONSTRAINT "squad_relationships_source_squad_id_squads_id_fk" FOREIGN KEY ("source_squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "squad_relationships" ADD CONSTRAINT "squad_relationships_target_squad_id_squads_id_fk" FOREIGN KEY ("target_squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "squads" ADD CONSTRAINT "squads_squad_type_id_squad_types_id_fk" FOREIGN KEY ("squad_type_id") REFERENCES "public"."squad_types"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "squads" ADD CONSTRAINT "squads_manager_agent_id_agents_id_fk" FOREIGN KEY ("manager_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_streams" ADD CONSTRAINT "work_streams_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_streams" ADD CONSTRAINT "work_streams_assignee_agent_id_agents_id_fk" FOREIGN KEY ("assignee_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_memory_chunks_embedding" ON "memory_chunks" USING ivfflat ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "idx_memory_documents_source_type" ON "memory_documents" USING btree ("squad_id","source_type");--> statement-breakpoint
CREATE INDEX "idx_memory_documents_path" ON "memory_documents" USING btree ("squad_id","path");