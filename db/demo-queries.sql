-- Demo queries for the sales conversation. Each one maps to a question that is
-- awkward in Cloudant (a MapReduce view per question, or a join done in app code).
-- Run after normalize.sql:
--   docker compose exec postgres psql -U app -d showcase -f /sql/demo-queries.sql

\echo '1. Revenue by region (a join across two document types, one statement)'
SELECT c.region,
       count(o.id)            AS orders,
       round(sum(o.total), 2) AS revenue
FROM orders_v o
JOIN customers_v c ON c.id = o.customer_id
GROUP BY c.region
ORDER BY revenue DESC;

\echo '2. Top 10 customers by lifetime value'
SELECT c.name,
       c.email,
       count(*)               AS orders,
       round(sum(o.total), 2) AS lifetime_value
FROM orders_v o
JOIN customers_v c ON c.id = o.customer_id
GROUP BY c.id, c.name, c.email
ORDER BY lifetime_value DESC
LIMIT 10;

\echo '3. Best-selling products (aggregating the line items inside each order)'
SELECT sku,
       sum(qty)                       AS units,
       round(sum(qty * unit_price), 2) AS revenue
FROM order_lines_v
GROUP BY sku
ORDER BY revenue DESC;

\echo '4. Who bought the LAPTOP-14 in the last 30 days'
SELECT DISTINCT c.name, c.region
FROM order_lines_v l
JOIN orders_v o    ON o.id = l.order_id
JOIN customers_v c ON c.id = o.customer_id
WHERE l.sku = 'LAPTOP-14'
  AND o.created_at >= now() - interval '30 days';

\echo '5. Shipped orders, straight from the JSON (GIN-indexed containment)'
SELECT id, body->>'customer_id' AS customer, (body->>'total')::numeric AS total
FROM docs
WHERE body @> '{"type": "order", "status": "shipped"}'
  AND NOT deleted
LIMIT 10;

\echo '6. Pre-computed monthly revenue by region (materialized view)'
SELECT month, region, orders, round(revenue, 2) AS revenue
FROM revenue_by_month_region
ORDER BY month DESC, region
LIMIT 12;

\echo '7. Sync health: rows, tombstones and the stored checkpoint'
SELECT count(*) FILTER (WHERE NOT deleted) AS live_docs,
       count(*) FILTER (WHERE deleted)     AS tombstones,
       (SELECT last_seq FROM checkpoints LIMIT 1) AS checkpoint
FROM docs;
