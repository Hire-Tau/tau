CREATE INDEX "idx_inbox_recipient_pagination" ON "inbox" USING btree ("recipient_type","recipient_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_inbox_system_pagination" ON "inbox" USING btree ("recipient_type","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_system_inbox_reads_user_message" ON "system_inbox_reads" USING btree ("user_id","message_id");