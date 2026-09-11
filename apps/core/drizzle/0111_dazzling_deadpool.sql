CREATE TABLE "work_stream_order_snapshot_items" (
	"snapshot_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"work_stream_id" uuid NOT NULL,
	CONSTRAINT "work_stream_order_snapshot_items_snapshot_id_ordinal_pk" PRIMARY KEY("snapshot_id","ordinal")
);
--> statement-breakpoint
CREATE TABLE "work_stream_order_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_key" text NOT NULL,
	"request_fingerprint" varchar(64) NOT NULL,
	"cursor_secret" varchar(64) NOT NULL,
	"snapshot_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"non_terminal_count" integer NOT NULL,
	"terminal_total_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "work_stream_order_snapshot_items" ADD CONSTRAINT "work_stream_order_snapshot_items_snapshot_id_work_stream_order_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."work_stream_order_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ws_order_snapshot_items_stream" ON "work_stream_order_snapshot_items" USING btree ("snapshot_id","work_stream_id");--> statement-breakpoint
CREATE INDEX "idx_ws_order_snapshots_expires" ON "work_stream_order_snapshots" USING btree ("expires_at");