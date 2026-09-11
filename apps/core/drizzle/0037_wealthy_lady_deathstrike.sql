CREATE INDEX "idx_executions_agent_status_started_at" ON "executions" USING btree ("agent_id","status","started_at");--> statement-breakpoint
CREATE INDEX "idx_work_streams_squad_created_at" ON "work_streams" USING btree ("squad_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_work_streams_status_updated_at" ON "work_streams" USING btree ("status","updated_at");