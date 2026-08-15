-- 012 — open tabs and per-course fire.
--
-- Additive only. This backs Task 8 (open tabs / send-to-kitchen): a dine-in
-- order is created when the waiter fires it to the kitchen, stays open and
-- unpaid while rounds are added, and is settled at the till afterwards.
--
-- Apply with:
--   npx wrangler d1 execute fufut-db --remote --file=migrations/012-open-tabs-courses.sql
--
-- NOTE: ALTER TABLE ADD COLUMN is not idempotent in SQLite. Re-running this
-- file fails on "duplicate column name", which means it already applied.

-- Courses let the kitchen fire a ticket in rounds (starters, then mains) rather
-- than everything at once. Default 'main' keeps every existing row meaningful:
-- an order that predates the column is a single-course ticket.
ALTER TABLE order_items ADD COLUMN course TEXT DEFAULT 'main';
