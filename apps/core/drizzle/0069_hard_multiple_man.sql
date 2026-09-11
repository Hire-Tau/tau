ALTER TABLE "machines" ADD COLUMN "purpose" text DEFAULT 'shared' NOT NULL;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "squad_id" text;