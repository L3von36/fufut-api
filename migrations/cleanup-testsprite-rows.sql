-- One-off cleanup of rows created by automated tests against production.
--
-- Not a schema migration; kept here so there is a record of exactly what was
-- removed and why. Safe to re-run: every statement is keyed on the TESTSPRITE
-- tag, so a second run simply matches nothing.
--
-- Apply with:
--   npx wrangler d1 execute fufut-db --remote --file=migrations/cleanup-testsprite-rows.sql

-- Tracking rows first: order_items has no foreign key onto orders, so deleting
-- the orders first would strand these with no way to identify them.
DELETE FROM order_items
 WHERE order_id IN (SELECT id FROM orders WHERE customer LIKE '%TESTSPRITE%');

DELETE FROM orders
 WHERE customer LIKE '%TESTSPRITE%';

-- Includes TESTSPRITE HOLD, which has been holding Table 10 out of service.
DELETE FROM reservations
 WHERE name LIKE '%TESTSPRITE%';

-- Leave any table these tests touched in a clean state. The tests only ever
-- attempted to seat T10 and were refused, but this makes the end state explicit
-- rather than assumed.
UPDATE tables
   SET status = 'available', seated_at = '', guests = 0, server = ''
 WHERE id IN ('T9', 'T10') AND status <> 'occupied';
