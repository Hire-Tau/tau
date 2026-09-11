-- Enable extensions for memory system
-- ParadeDB image includes both, but we create them explicitly
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_search;
