-- 023 — kitchen tick + open-checks index.
--
-- Two queries hit `orders` on every hot path of the floor:
--
--   1. The kitchen SSE tick (handlers/sse.js) runs every 10s per connected
--      kitchen/pipeline client:
--        SELECT * FROM orders
--         WHERE status NOT IN ('completed','cancelled','fulfilled')
--         ORDER BY created DESC LIMIT 200
--
--   2. listOpenChecks (handlers/orders.js) runs every time the Open Checks
--      screen refreshes, with a similar predicate on status and a filter on
--      payment_status / voided_at.
--
-- Today the only indexes on `orders` are the three single-column indexes added
-- by migration 005: idx_orders_created, idx_orders_status, idx_orders_paystatus.
-- A single-column index on `status` does not help a query that filters status
-- by NOT IN and orders by `created DESC` — the planner either scans the table
-- and sorts, or scans idx_orders_created and filters row-by-row. On a busy week
-- (thousands of historical orders, ~50 active) both plans cost more than they
-- should, and the cost grows with history rather than with current load.
--
-- This composite index gives both queries a single seek-then-scan that returns
-- the active rows already in created-desc order. It is purely additive — no
-- query plan changes for queries that don't filter on status.
--
-- Apply with:
--   npx wrangler d1 execute fufut-db --remote --file=migrations/023-kitchen-tick-index.sql

CREATE INDEX IF NOT EXISTS idx_orders_status_created
  ON orders(status, created DESC);

-- Same shape for open-checks: listOpenChecks filters on payment_status and
-- voided_at, and orders by created DESC. A composite index lets it seek to
-- "unpaid, not-voided" in one go and walk the active rows in order.
CREATE INDEX IF NOT EXISTS idx_orders_paystatus_voided_created
  ON orders(payment_status, voided_at, created DESC);
