CREATE SEQUENCE "public"."work_stream_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1;--> statement-breakpoint
ALTER TABLE "user_notification_preferences" ADD COLUMN "show_previews" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "work_streams" ADD COLUMN "number" integer;--> statement-breakpoint
ALTER TABLE "work_streams" ADD CONSTRAINT "work_streams_number_unique" UNIQUE("number");--> statement-breakpoint
ALTER TABLE "work_streams" ALTER COLUMN "number" SET DEFAULT nextval('work_stream_number_seq');--> statement-breakpoint
ALTER TABLE "work_streams" ALTER COLUMN "number" SET NOT NULL;