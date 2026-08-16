-- CFG 003 — reorder points and target stock.
--
-- ── Why this is safe to set before a real count, when stock levels were not ─
--
-- A reorder point is a *policy*: "order coffee when it falls below 8 kg" is a
-- statement about lead time and usage, and it is true regardless of what is on
-- the shelf this morning. A stock level is a *measurement*, which is why one
-- could be reasoned about and the other had to be invented.
--
-- Seed 005 deliberately left these unset so that no purchase order could be
-- raised against estimated quantities. That protection is now removed at the
-- business's instruction, so state the consequence plainly:
--
--   **Until the physical count clears `stock_estimated`, every low-stock alert
--   is a comparison between a real threshold and a made-up level.** Alerts will
--   fire for things that are full and stay silent for things that are empty.
--   Check the shelf before ordering against one.
--
-- ── The formula ────────────────────────────────────────────────────────────
--
-- Derived from the seed-005 holding rather than invented separately, so the two
-- stay coherent:
--
--   target_stock  = the estimated holding (roughly a week)
--   reorder_point = 40% of it (roughly 2-3 days' cover)
--
-- 40% is a lead-time judgement, not a measurement: it assumes a supplier can
-- deliver within two or three days. Perishables are set tighter because
-- over-ordering them is waste rather than working capital, and the two fuels
-- are set to a whole spare unit because running out of gas mid-service stops
-- the kitchen entirely.
--
-- All of this should be revisited once there is real usage data — the forecast
-- endpoint will report actual daily usage per item, which is a far better basis
-- than a percentage of a guess.
--
-- Apply with:
--   npx wrangler d1 execute fufut-db --remote --file=migrations/cfg-003-reorder-points.sql

-- ─────────────────────────────────────────────────────────────────────────────
-- General rule: reorder at 40% of the target holding
-- ─────────────────────────────────────────────────────────────────────────────
-- Applied from current stock because that is where the seed-005 estimate lives.
-- Anything already holding zero is skipped rather than given a zero threshold,
-- which would read as "never reorder".
UPDATE inventory
   SET target_stock  = stock,
       reorder_point = ROUND(stock * 0.40, 2),
       updated_at    = datetime('now')
 WHERE (active IS NULL OR active = 1)
   AND COALESCE(stock, 0) > 0;

-- ─────────────────────────────────────────────────────────────────────────────
-- Perishables — tighter, because over-ordering these is spoilage
-- ─────────────────────────────────────────────────────────────────────────────
-- Reorder at 50% so the gap is short, and hold less: buying a fortnight of
-- lettuce is not prudence, it is bin liner.
UPDATE inventory
   SET reorder_point = ROUND(stock * 0.50, 2),
       updated_at    = datetime('now')
 WHERE track_expiry = 1 AND COALESCE(stock, 0) > 0;

-- ─────────────────────────────────────────────────────────────────────────────
-- Fuel — a whole spare unit, not a percentage
-- ─────────────────────────────────────────────────────────────────────────────
-- Running out of gas mid-service stops every hot dish at once, so the threshold
-- is "always have a spare cylinder", which a percentage cannot express.
UPDATE inventory SET reorder_point = 2,  target_stock = 6,   updated_at = datetime('now') WHERE id = 'I-gas';
UPDATE inventory SET reorder_point = 40, target_stock = 120, updated_at = datetime('now') WHERE id = 'I-charcoal';

-- ─────────────────────────────────────────────────────────────────────────────
-- Beef — the one item with a measured level and a known supplier
-- ─────────────────────────────────────────────────────────────────────────────
-- 40 kg came in and it is the most expensive thing on the list, so it is held
-- to a tighter cycle than the estimates around it.
UPDATE inventory
   SET reorder_point = 12,
       target_stock  = 40,
       preferred_supplier_id = 'SUPa679437',
       updated_at = datetime('now')
 WHERE id = 'I-beef';

INSERT OR IGNORE INTO audit_log
  (id, at, actor_id, actor_name, actor_role, action, entity, entity_id, before, after, reason)
VALUES
  ('AL-cfg003-reorder', datetime('now'), NULL, 'system (cfg 003)', 'system', 'update',
   'inventory', NULL, '{"reorder_point":null}', '{"reorder_point":"40% of holding, 50% for perishables"}',
   'Reorder points and targets set at the business''s instruction. NOTE: seed-005 left these unset so no purchase could be raised against estimated stock. Until a physical count clears stock_estimated, every low-stock alert compares a real threshold against a made-up level.');
