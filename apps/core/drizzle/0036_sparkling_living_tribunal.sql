CREATE INDEX "idx_agents_parent_agent_id" ON "agents" USING btree ("parent_agent_id");--> statement-breakpoint
CREATE INDEX "idx_agents_squad_id" ON "agents" USING btree ("squad_id");--> statement-breakpoint
CREATE INDEX "idx_messages_agent_id_created_at" ON "messages" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_messages_agent_id_role_created_at" ON "messages" USING btree ("agent_id","role","created_at");