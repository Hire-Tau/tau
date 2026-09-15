ALTER TABLE "work_streams" ADD COLUMN "number" integer;--> statement-breakpoint
ALTER TABLE "work_streams" ADD CONSTRAINT "work_streams_number_unique" UNIQUE("number");