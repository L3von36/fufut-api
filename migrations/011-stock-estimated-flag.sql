-- 011 — flag stock that was estimated rather than counted.
--
-- Same pattern as recipes.provisional and payroll_runs.provisional, for the
-- same reason: a figure nobody verified must not be indistinguishable from one
-- somebody walked the store room to establish.
--
-- Cleared per item by the first real count, so it doubles as the worklist —
-- "which shelves has anybody actually looked at".
--
-- Apply with:
--   npx wrangler d1 execute fufut-db --remote --file=migrations/011-stock-estimated-flag.sql

ALTER TABLE inventory ADD COLUMN stock_estimated INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_inventory_estimated
  ON inventory(stock_estimated) WHERE stock_estimated = 1;
