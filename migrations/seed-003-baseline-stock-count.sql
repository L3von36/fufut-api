-- SEED 003 — the opening stock count, everything at zero.
--
-- ── What this does, and what it does not ────────────────────────────────────
--
-- Every item currently reads zero, and this count records zero, so the variance
-- on every line is zero and **no stock movement is written**. Nothing changes
-- quantity. That is not a failure of the seed — it is what a count that agrees
-- with the system looks like, and it mirrors postCount() exactly: that handler
-- writes a movement only when `Math.abs(variance) > 1e-9`, because a count that
-- reconciles cleanly is a result worth recording and not a correction to make.
--
-- What it produces is a **dated, attributed opening position**: on this date
-- somebody asserted the shelves matched the system at nil. Every subsequent
-- purchase, sale and count is measured from here, and `reconciliation` uses the
-- last balance before a window as its opening figure — so having a real point
-- of origin is what stops the first month's numbers hanging off nothing.
--
-- ── The honest caveat ───────────────────────────────────────────────────────
--
-- Fufut is a trading restaurant, so there is in reality coffee, injera and oil
-- in the building right now. This count asserts otherwise. That is a deliberate
-- choice to start the ledger from a clean, known point rather than from an
-- estimate, and it is recorded as such in the notes and the audit log. The
-- first real count will show large positive variances against it, which is
-- correct and expected — they are the opening stock arriving on the books, not
-- a discrepancy anybody needs to explain.
--
-- Apply with:
--   npx wrangler d1 execute fufut-db --remote --file=migrations/seed-003-baseline-stock-count.sql
--
-- Safe to re-run: OR IGNORE on deterministic primary keys.

-- ─────────────────────────────────────────────────────────────────────────────
-- The count
-- ─────────────────────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO stock_counts
  (id, started_at, completed_at, status, counted_by, counted_by_name, notes)
VALUES
  ('SC-baseline-000', datetime('now'), datetime('now'), 'posted', NULL, 'system (seed 003)',
   'Opening baseline. Every item recorded at zero to establish a known starting point before real quantities are entered. The first physical count will show large positive variances against this; that is the opening stock arriving on the books, not a discrepancy.');

-- ─────────────────────────────────────────────────────────────────────────────
-- One line per active item, generated from the catalogue
-- ─────────────────────────────────────────────────────────────────────────────
-- Selected from `inventory` rather than listed by hand, so this cannot drift
-- out of step with the catalogue if an item is added before it runs. The id is
-- derived from the item id, which keeps it deterministic for the OR IGNORE.
INSERT OR IGNORE INTO stock_count_items
  (id, count_id, inventory_id, system_qty, counted_qty, variance, unit, reason, notes)
SELECT
  'SCI-baseline-' || i.id,
  'SC-baseline-000',
  i.id,
  COALESCE(i.stock, 0),   -- what the system believed
  0,                      -- what was recorded
  0 - COALESCE(i.stock, 0),
  i.unit,
  'Opening baseline count',
  NULL
FROM inventory i
WHERE i.active IS NULL OR i.active = 1;

-- ─────────────────────────────────────────────────────────────────────────────
-- Adjustments for anything that was not already zero
-- ─────────────────────────────────────────────────────────────────────────────
-- Defensive rather than expected: at the time of writing every item is zero, so
-- this inserts nothing. It is here because the seed must not silently leave a
-- non-zero item unreconciled if one is created between seeding the catalogue
-- and running this — the count would then claim a variance it never posted, and
-- `stock` would disagree with SUM(qty) over the ledger, which is the one
-- property the whole design rests on.
INSERT OR IGNORE INTO stock_movements
  (id, at, inventory_id, qty, unit, type, ref_type, ref_id, unit_cost, total_cost,
   balance_after, actor_id, actor_name, reason, notes)
SELECT
  'SM-baseline-' || i.id,
  datetime('now'),
  i.id,
  0 - i.stock,
  i.unit,
  'count',
  'stock_counts',
  'SC-baseline-000',
  COALESCE(i.avg_cost, i.cost, 0),
  0,
  0,
  NULL,
  'system (seed 003)',
  'Opening baseline count',
  NULL
FROM inventory i
WHERE (i.active IS NULL OR i.active = 1)
  AND COALESCE(i.stock, 0) <> 0;

UPDATE inventory
   SET stock = 0, updated_at = datetime('now')
 WHERE (active IS NULL OR active = 1)
   AND COALESCE(stock, 0) <> 0;

-- ─────────────────────────────────────────────────────────────────────────────
-- Audit
-- ─────────────────────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO audit_log
  (id, at, actor_id, actor_name, actor_role, action, entity, entity_id, before, after, reason)
VALUES
  ('AL-seed003-count', datetime('now'), NULL, 'system (seed 003)', 'system', 'adjust',
   'stock_counts', 'SC-baseline-000', NULL,
   '{"items":73,"counted":0,"movements":0}',
   'Opening baseline: all items recorded at zero to establish a starting point. No movements written because every line already read zero.');
