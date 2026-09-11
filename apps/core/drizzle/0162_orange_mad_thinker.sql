-- `pending_termination_at` is set inside makeDormant(), on the branch where
-- the agent still has a live execution -- so it marks a DEFERRED DORMANCY,
-- not a pending termination. The eventual end state is tracked separately in
-- metadata->>'pendingLifecycleTarget', which is 'dormant' OR 'terminated'.
-- The old name described the wrong transition and read as though every
-- deferral ended in termination.
--
-- RENAME preserves data, type, defaults and indexes; no rows are rewritten.
ALTER TABLE "agents" RENAME COLUMN "pending_termination_at" TO "pending_dormancy_at";
