-- Add selected_model column to agents (the runtime-selected single model spec,
-- after priority-list fallback). Previously stored in metadata.selectedModel (JSONB).
ALTER TABLE "agents" ADD COLUMN "selected_model" varchar(500);

-- Backfill from metadata.selectedModel for existing rows.
UPDATE "agents"
SET "selected_model" = ("metadata"->>'selectedModel')
WHERE "metadata"->>'selectedModel' IS NOT NULL;
