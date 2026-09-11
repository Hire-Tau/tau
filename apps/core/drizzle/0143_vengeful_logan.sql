ALTER TABLE "local_deployments" ADD COLUMN "port_scope" text DEFAULT '' NOT NULL;--> statement-breakpoint
-- Backfill BEFORE the unique index exists. Every pre-existing deployment gets
-- the SANDBOX scope, which is exactly the rule in force when it was created:
-- docker and k8s give each sandbox its own network namespace, so two squads on
-- port 3000 were legal and still are. Scoping existing rows globally, or to a
-- machine, would retroactively invalidate deployments that are running fine.
--
-- VM instances therefore keep existing rows on the sandbox scope until those
-- deployments are recreated; new ones take the machine scope and are
-- collision-checked. Deliberate: rewriting live rows into a stricter scope
-- could fail this migration on a duplicate that is currently serving traffic.
UPDATE "local_deployments" SET "port_scope" = 'sandbox:' || "sandbox_id" WHERE "port_scope" = '';--> statement-breakpoint
-- Two LIVE deployments in one sandbox on one port cannot both work — the second
-- never bound. Archiving the older ones is the difference between this
-- migration failing a fleet upgrade and it succeeding; nothing reachable is
-- lost, because a row in this state was already dead.
UPDATE "local_deployments" SET "archived_at" = now()
WHERE "archived_at" IS NULL
  AND "id" NOT IN (
    SELECT DISTINCT ON ("port_scope", "port") "id"
    FROM "local_deployments"
    WHERE "archived_at" IS NULL
    ORDER BY "port_scope", "port", "created_at" DESC, "id" DESC
  );--> statement-breakpoint
CREATE UNIQUE INDEX "local_deployments_live_port_scope_uniq" ON "local_deployments" USING btree ("port_scope","port") WHERE archived_at is null;
