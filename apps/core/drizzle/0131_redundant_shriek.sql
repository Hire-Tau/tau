ALTER TABLE "integration_event_polling_dispatches" ADD COLUMN "activity_squad_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL;
