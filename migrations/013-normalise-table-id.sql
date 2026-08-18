-- 013 — one spelling for a table reference.
--
--   npx wrangler d1 execute fufut-db --remote --file=migrations/013-normalise-table-id.sql
--
-- orders.table_id is a string and every screen compares it as one, so "7.0"
-- and "7" are different tables as far as the floor plan is concerned: an order
-- written "7.0" shows no open-tab badge and Add Round cannot find it.
--
-- Three rows were written that way, by whatever passed a number through
-- String() before the API normalised on write (see lib/staleness.js).
--
-- Only the exact malformed values are touched. A blanket CAST would rewrite a
-- table genuinely labelled "2.5" or "A1", and this table is free text.
UPDATE orders SET table_id = '7' WHERE table_id = '7.0';
UPDATE orders SET table_id = '2' WHERE table_id = '2.0';
UPDATE orders SET table_id = '3' WHERE table_id = '03';
