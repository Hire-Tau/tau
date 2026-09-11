CREATE TABLE "memory_access_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"caller_squad_id" uuid NOT NULL,
	"source_squad_id" uuid NOT NULL,
	"caller_agent_id" uuid,
	"action" text NOT NULL,
	"resource_path" text,
	"result_count" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "squad_memory_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_squad_id" uuid NOT NULL,
	"grantee_squad_id" uuid NOT NULL,
	"policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_chunks" ADD COLUMN "sensitivity" text DEFAULT 'internal' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_documents" ADD COLUMN "sensitivity" text DEFAULT 'internal' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_access_audit" ADD CONSTRAINT "memory_access_audit_caller_squad_id_squads_id_fk" FOREIGN KEY ("caller_squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_access_audit" ADD CONSTRAINT "memory_access_audit_source_squad_id_squads_id_fk" FOREIGN KEY ("source_squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_access_audit" ADD CONSTRAINT "memory_access_audit_caller_agent_id_agents_id_fk" FOREIGN KEY ("caller_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "squad_memory_grants" ADD CONSTRAINT "squad_memory_grants_source_squad_id_squads_id_fk" FOREIGN KEY ("source_squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "squad_memory_grants" ADD CONSTRAINT "squad_memory_grants_grantee_squad_id_squads_id_fk" FOREIGN KEY ("grantee_squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_memory_access_audit_caller" ON "memory_access_audit" USING btree ("caller_squad_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_memory_access_audit_source" ON "memory_access_audit" USING btree ("source_squad_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_squad_memory_grants_grantee" ON "squad_memory_grants" USING btree ("grantee_squad_id");--> statement-breakpoint
CREATE INDEX "idx_squad_memory_grants_source" ON "squad_memory_grants" USING btree ("source_squad_id");--> statement-breakpoint
CREATE INDEX "idx_memory_chunks_sensitivity" ON "memory_chunks" USING btree ("squad_id","sensitivity");--> statement-breakpoint
CREATE INDEX "idx_memory_documents_sensitivity" ON "memory_documents" USING btree ("squad_id","sensitivity");