-- 008 — record which batches a movement drew from.
--
-- `inventory_batches.qty_remaining` was written when a purchase was received
-- and never decremented, so the expiring-stock report showed the full delivered
-- quantity forever — milk drunk three weeks ago still counted as at risk.
--
-- Consumption now draws down batches first-to-expire. This column stores which
-- batches a movement took from, so a reversal puts the quantity back into the
-- batch it actually came out of. Re-deriving the allocation at reversal time
-- would pick today's first-to-expire batch, which is generally a different
-- carton with a different date, and would corrupt the report this exists to
-- make honest.
--
-- Additive. Apply with:
--   npx wrangler d1 execute fufut-db --remote --file=migrations/008-batch-allocations.sql

ALTER TABLE stock_movements ADD COLUMN batch_alloc TEXT;

-- Reversal looks a movement up by what it referenced, so the existing
-- idx_moves_ref covers it. This one supports "which movements touched this
-- batch", which is the question asked when a batch is recalled or written off.
CREATE INDEX IF NOT EXISTS idx_moves_batch ON stock_movements(inventory_id, at)
  WHERE batch_alloc IS NOT NULL;
