LOCK TABLE "push_subscriptions" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
WITH duplicate_endpoints AS (
  SELECT endpoint, count(DISTINCT user_id) AS owner_count
  FROM push_subscriptions
  GROUP BY endpoint
  HAVING count(*) > 1
), ranked AS (
  SELECT
    subscription.id,
    duplicate.owner_count,
    row_number() OVER (
      PARTITION BY subscription.endpoint
      ORDER BY subscription.created_at DESC, subscription.id DESC
    ) AS endpoint_rank
  FROM push_subscriptions AS subscription
  INNER JOIN duplicate_endpoints AS duplicate
    ON duplicate.endpoint = subscription.endpoint
)
DELETE FROM push_subscriptions AS subscription
USING ranked
WHERE subscription.id = ranked.id
  AND (ranked.owner_count > 1 OR ranked.endpoint_rank > 1);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_push_subscriptions_endpoint_unique" ON "push_subscriptions" USING btree ("endpoint");
