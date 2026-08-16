-- TXN 001 — first real purchase: 40 kg beef from novel, 28,000 ETB, paid cash.
--
-- This is a genuine business transaction, not a seed, and it is in git for the
-- same reason the drift check exists: something that changed production and
-- left no trace is the failure this repository was created to stop.
--
-- ── Attribution ────────────────────────────────────────────────────────────
--
-- Recorded as 'system (txn 001)' rather than as a member of staff. Signing in
-- as Amanuel to make the audit entry say his name would be false — he did not
-- record this. An honest 'system' entry that a manager can ask about beats a
-- convincing wrong one.
--
-- ── What this replicates ───────────────────────────────────────────────────
--
-- Exactly what createPurchase() + postMovement() do, in order:
--   1. the purchase header, status 'received' and posted_at set
--   2. the line, with unit_cost expressed per *stocking* unit
--   3. a stock movement of +40 kg, type 'purchase'
--   4. inventory.stock and the weighted average cost
--   5. a batch, because beef is flagged track_expiry
--   6. an audit entry
--
-- 28,000 / 40 = 700 ETB per kg. With no prior stock, newAverageCost() returns
-- the incoming price rather than averaging against a zero balance, so avg_cost
-- becomes 700 — the figure every margin calculation will use until the next
-- delivery moves it.
--
-- ── Expiry deliberately left null ──────────────────────────────────────────
--
-- Beef carries shelf_life_days = 3 from the catalogue seed, so a date could be
-- derived. It is not, because that figure was my assumption about ordinary
-- storage and this is real meat in a real fridge: a guessed use-by on a
-- perishable is a food-safety claim, and the batch is more useful with an
-- honest blank than with a date nobody set. FEFO sorts undated batches last,
-- degrading to FIFO, which is correct while there is only one.
--
-- Set it from the Purchases screen, or:
--   UPDATE inventory_batches SET expiry_date = 'YYYY-MM-DD' WHERE id = 'BT-20260811-beef';
--
-- Apply with:
--   npx wrangler d1 execute fufut-db --remote --file=migrations/txn-001-purchase-beef.sql

-- 1. The purchase. Paid in full, so nothing is outstanding against novel.
INSERT OR IGNORE INTO purchases
  (id, supplier_id, supplier_name, date, total, paid, payment_method, status,
   receipt_key, notes, posted_at, created_by, created_by_name, created)
VALUES
  ('PU-20260811-beef', 'SUPa679437', 'novel', date('now'),
   28000, 28000, 'cash', 'received',
   NULL, 'First recorded purchase. 40 kg beef at 700 ETB/kg, paid cash in full.',
   datetime('now'), NULL, 'system (txn 001)', datetime('now'));

-- 2. The line. unit_cost is per kg — the stocking unit — because a price per
--    sack would be meaningless against stock held in kg.
INSERT OR IGNORE INTO purchase_items
  (id, purchase_id, inventory_id, qty, unit, unit_cost, total_cost, batch_no, expiry_date)
VALUES
  ('PI-20260811-beef', 'PU-20260811-beef', 'I-beef', 40, 'kg', 700, 28000, NULL, NULL);

-- 3. The movement. Signed positive; balance_after is what inventory.stock must
--    agree with, and stock being rebuildable from SUM(qty) is the property the
--    whole ledger rests on.
INSERT OR IGNORE INTO stock_movements
  (id, at, inventory_id, qty, unit, type, ref_type, ref_id, unit_cost, total_cost,
   balance_after, actor_id, actor_name, reason, notes)
VALUES
  ('SM-20260811-beef', datetime('now'), 'I-beef', 40, 'kg', 'purchase',
   'purchases', 'PU-20260811-beef', 700, 28000, 40,
   NULL, 'system (txn 001)', 'Purchase from novel', NULL);

-- 4. Running balance and cost. avg_cost is what recipeCost() reads, so this is
--    the write that makes beef dishes costable at all.
UPDATE inventory
   SET stock = 40,
       avg_cost = 700,
       last_cost = 700,
       cost = CASE WHEN COALESCE(cost, 0) = 0 THEN 700 ELSE cost END,
       updated_at = datetime('now')
 WHERE id = 'I-beef';

-- 5. The batch. Created because beef is track_expiry = 1; qty_remaining is what
--    FEFO draws down and what "expiring soon" reports, so it starts equal to
--    what arrived.
INSERT OR IGNORE INTO inventory_batches
  (id, inventory_id, purchase_item_id, supplier_id, batch_no, received_at,
   expiry_date, qty_received, qty_remaining, unit, unit_cost, status)
VALUES
  ('BT-20260811-beef', 'I-beef', 'PI-20260811-beef', 'SUPa679437', NULL,
   datetime('now'), NULL, 40, 40, 'kg', 700, 'open');

-- 6. Audit.
INSERT OR IGNORE INTO audit_log
  (id, at, actor_id, actor_name, actor_role, action, entity, entity_id, before, after, reason)
VALUES
  ('AL-txn001-purchase', datetime('now'), NULL, 'system (txn 001)', 'system', 'create',
   'purchases', 'PU-20260811-beef', NULL,
   '{"supplier_id":"SUPa679437","supplier_name":"novel","total":28000,"paid":28000,"lines":1,"received":true}',
   'First recorded purchase: 40 kg beef at 700 ETB/kg, paid cash in full.');
