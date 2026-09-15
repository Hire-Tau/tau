CREATE SEQUENCE "public"."work_stream_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1;--> statement-breakpoint
ALTER TABLE "work_streams" ALTER COLUMN "number" SET DEFAULT nextval('work_stream_number_seq');--> statement-breakpoint
ALTER TABLE "work_streams" ALTER COLUMN "number" SET NOT NULL;