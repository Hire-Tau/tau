CREATE TABLE "agent_extra_scopes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"permission" text NOT NULL,
	"granted_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_extra_scopes" ADD CONSTRAINT "agent_extra_scopes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_extra_scopes" ADD CONSTRAINT "agent_extra_scopes_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_scope" ON "agent_extra_scopes" USING btree ("agent_id","permission");--> statement-breakpoint
CREATE INDEX "idx_agent_scopes_agent" ON "agent_extra_scopes" USING btree ("agent_id");