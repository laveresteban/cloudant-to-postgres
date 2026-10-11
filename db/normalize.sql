-- Step 2 of the migration: give the JSON documents a relational shape.
-- Views copy no data and need no app change, so they are the safe first move.
-- Run after the initial sync: docker compose exec postgres psql -U app -d showcase -f /sql/normalize.sql

CREATE OR REPLACE VIEW customers_v AS
SELECT id,
       body->>'name'                       AS name,
       body->>'email'                      AS email,
       body->>'region'                     AS region,
       (body->>'created_at')::timestamptz  AS created_at
FROM docs
WHERE body->>'type' = 'customer' AND NOT deleted;

CREATE OR REPLACE VIEW orders_v AS
SELECT id,
       body->>'customer_id'                AS customer_id,
       body->>'status'                     AS status,
       (body->>'total')::numeric(12, 2)    AS total,
       (body->>'created_at')::timestamptz  AS created_at
FROM docs
WHERE body->>'type' = 'order' AND NOT deleted;

-- Line items were an array inside each order document. Here they become rows.
CREATE OR REPLACE VIEW order_lines_v AS
SELECT d.id                                    AS order_id,
       d.body->>'customer_id'                  AS customer_id,
       line->>'sku'                            AS sku,
       (line->>'qty')::int                     AS qty,
       (line->>'unit_price')::numeric(12, 2)   AS unit_price
FROM docs d
CROSS JOIN LATERAL jsonb_array_elements(d.body->'items') AS line
WHERE d.body->>'type' = 'order' AND NOT d.deleted;

-- Step 3 (when reporting load justifies it): precompute the expensive report.
-- The unique index lets REFRESH ... CONCURRENTLY run without blocking readers.
CREATE MATERIALIZED VIEW IF NOT EXISTS revenue_by_month_region AS
SELECT date_trunc('month', o.created_at) AS month,
       c.region,
       count(*)                          AS orders,
       sum(o.total)                      AS revenue
FROM orders_v o
JOIN customers_v c ON c.id = o.customer_id
GROUP BY 1, 2;

CREATE UNIQUE INDEX IF NOT EXISTS revenue_by_month_region_key
  ON revenue_by_month_region (month, region);

-- Refresh on a schedule, for example from pg_cron:
-- REFRESH MATERIALIZED VIEW CONCURRENTLY revenue_by_month_region;
