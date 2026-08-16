-- SEED 005 — estimated opening stock.
--
-- ⚠ NOBODY COUNTED ANY OF THIS.
--
-- Entered at the business's explicit instruction, to be replaced by a real
-- count. Every quantity is invented: sized as roughly a week's holding for a
-- café running this menu, with no knowledge of actual covers per day or of what
-- is on the shelves this morning.
--
-- ── Three safeguards, because this is the least verifiable data in the system ─
--
-- 1. **Flagged.** Every item gets `stock_estimated = 1`. A count clears it, so
--    the flag is also the worklist of shelves nobody has looked at.
--
-- 2. **Movements are type 'adjustment', not 'count'.** A count means a person
--    counted. Recording these as counts would put a lie in the movement type
--    itself, and the variance report reads that type. The reason on every row
--    says ESTIMATE in capitals.
--
-- 3. **Reorder points are left unset.** This is the important one. With no
--    reorder point, `reorderSuggestion()` returns null and the item never
--    reaches the buying list — so nobody can place an order against a quantity
--    I made up. Set reorder points *after* the real count, not before.
--
-- ── What this improves, and what it makes worse ─────────────────────────────
--
-- Better: capacity figures and "what can we make" produce numbers instead of
-- zeros; sales stop driving stock negative; the ledger has a starting level.
--
-- Worse: those numbers are wrong, and they look exactly like right ones. The
-- specific operational risk is somebody seeing "Coffee beans 20 kg" and not
-- ordering coffee. The reorder-point safeguard above is what stops that
-- becoming a purchasing decision, but it does not stop a person reading the
-- screen and drawing a conclusion.
--
-- Quantities are deliberately round — 20, 40, 300 — because a round number
-- reads as an estimate to a human in a way that 18.7 does not.
--
-- Beef is excluded: it holds a real 40 kg from a real purchase, and overwriting
-- measured stock with a guess would be strictly worse than doing nothing.
--
-- Requires 011. Apply with:
--   npx wrangler d1 execute fufut-db --remote --file=migrations/seed-005-estimated-opening-stock.sql

-- ─────────────────────────────────────────────────────────────────────────────
-- A record of the act, typed honestly. Not called a count.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO stock_counts
  (id, started_at, completed_at, status, counted_by, counted_by_name, notes)
VALUES
  ('SC-estimate-001', datetime('now'), datetime('now'), 'posted', NULL, 'system (seed 005)',
   'ESTIMATED OPENING STOCK — NOT A COUNT. Quantities invented at the business''s instruction pending a physical count. Every affected item carries stock_estimated = 1. Do not treat any figure here as observed.');

-- ─────────────────────────────────────────────────────────────────────────────
-- The estimates
-- ─────────────────────────────────────────────────────────────────────────────
-- Held as a CTE and applied set-based, so the quantity for each item is written
-- exactly once and the movement, the count line and the balance cannot drift
-- apart from each other.
WITH est(inv_id, qty) AS (VALUES
  -- Coffee & tea. 20 kg of beans is roughly 1,100 macchiatos at the draft dose.
  ('I-coffee-beans', 20), ('I-tea-leaves', 5), ('I-ginger', 3), ('I-honey', 4),
  -- Dairy & eggs. Short shelf life, so held tighter than the dry goods.
  ('I-milk', 60), ('I-eggs', 300), ('I-butter', 8), ('I-cheese', 5),
  -- Staples. Injera and bread turn over daily.
  ('I-injera', 400), ('I-bread', 100), ('I-teff-flour', 30), ('I-wheat-flour', 40),
  ('I-pasta', 15), ('I-rice', 20),
  -- Proteins. Beef deliberately absent — it holds real stock.
  ('I-chicken', 25), ('I-lamb', 15), ('I-tuna', 40), ('I-shiro', 30),
  ('I-lentils', 20), ('I-fava', 15), ('I-chickpeas', 10),
  -- Vegetables
  ('I-onion', 40), ('I-tomato', 30), ('I-garlic', 5), ('I-green-pepper', 8),
  ('I-lettuce', 10), ('I-cabbage', 15), ('I-carrot', 12), ('I-potato', 25),
  ('I-beetroot', 8), ('I-cucumber', 10),
  -- Fruit
  ('I-pineapple', 15), ('I-mango', 15), ('I-watermelon', 20), ('I-orange', 20),
  ('I-strawberry', 5), ('I-lemon', 8), ('I-avocado', 12), ('I-banana', 15),
  ('I-papaya', 12),
  -- Oil & spice
  ('I-oil', 40), ('I-sugar', 30), ('I-salt', 10), ('I-berbere', 12),
  ('I-mitmita', 4), ('I-black-pepper', 2), ('I-cardamom', 2), ('I-tomato-paste', 10),
  -- Bought in
  ('I-soft-drink', 200), ('I-malt', 60), ('I-water-500', 200), ('I-water-1l', 100),
  ('I-water-2l', 60), ('I-sparkling', 40),
  -- Fuel
  ('I-charcoal', 100), ('I-gas', 4),
  -- Packaging
  ('I-box-small', 300), ('I-box-large', 300), ('I-coffee-cup', 500),
  ('I-tea-cup', 300), ('I-plastic-cup', 300), ('I-lid', 800),
  ('I-paper-bag', 400), ('I-plastic-bag', 400), ('I-spoon', 500),
  ('I-fork', 500), ('I-knife', 200), ('I-napkin', 2000), ('I-straw', 500),
  -- Cleaning
  ('I-dish-soap', 10), ('I-bleach', 10), ('I-cleaning-cloth', 20)
)
INSERT OR IGNORE INTO stock_movements
  (id, at, inventory_id, qty, unit, type, ref_type, ref_id, unit_cost, total_cost,
   balance_after, actor_id, actor_name, reason, notes)
SELECT
  'SM-est-' || e.inv_id,
  datetime('now'),
  e.inv_id,
  e.qty - COALESCE(i.stock, 0),
  i.unit,
  -- 'adjustment', never 'count'. Nobody counted.
  'adjustment',
  'stock_counts',
  'SC-estimate-001',
  COALESCE(i.avg_cost, i.cost, 0),
  0,
  e.qty,
  NULL,
  'system (seed 005)',
  'ESTIMATE — opening stock, not physically counted',
  NULL
FROM est e JOIN inventory i ON i.id = e.inv_id
WHERE e.qty <> COALESCE(i.stock, 0);

-- The count lines, so the estimate appears in the same history a real count
-- will, and the first count reads as a correction of a stated position rather
-- than a figure arriving from nowhere.
WITH est(inv_id, qty) AS (VALUES
  ('I-coffee-beans', 20), ('I-tea-leaves', 5), ('I-ginger', 3), ('I-honey', 4),
  ('I-milk', 60), ('I-eggs', 300), ('I-butter', 8), ('I-cheese', 5),
  ('I-injera', 400), ('I-bread', 100), ('I-teff-flour', 30), ('I-wheat-flour', 40),
  ('I-pasta', 15), ('I-rice', 20),
  ('I-chicken', 25), ('I-lamb', 15), ('I-tuna', 40), ('I-shiro', 30),
  ('I-lentils', 20), ('I-fava', 15), ('I-chickpeas', 10),
  ('I-onion', 40), ('I-tomato', 30), ('I-garlic', 5), ('I-green-pepper', 8),
  ('I-lettuce', 10), ('I-cabbage', 15), ('I-carrot', 12), ('I-potato', 25),
  ('I-beetroot', 8), ('I-cucumber', 10),
  ('I-pineapple', 15), ('I-mango', 15), ('I-watermelon', 20), ('I-orange', 20),
  ('I-strawberry', 5), ('I-lemon', 8), ('I-avocado', 12), ('I-banana', 15),
  ('I-papaya', 12),
  ('I-oil', 40), ('I-sugar', 30), ('I-salt', 10), ('I-berbere', 12),
  ('I-mitmita', 4), ('I-black-pepper', 2), ('I-cardamom', 2), ('I-tomato-paste', 10),
  ('I-soft-drink', 200), ('I-malt', 60), ('I-water-500', 200), ('I-water-1l', 100),
  ('I-water-2l', 60), ('I-sparkling', 40),
  ('I-charcoal', 100), ('I-gas', 4),
  ('I-box-small', 300), ('I-box-large', 300), ('I-coffee-cup', 500),
  ('I-tea-cup', 300), ('I-plastic-cup', 300), ('I-lid', 800),
  ('I-paper-bag', 400), ('I-plastic-bag', 400), ('I-spoon', 500),
  ('I-fork', 500), ('I-knife', 200), ('I-napkin', 2000), ('I-straw', 500),
  ('I-dish-soap', 10), ('I-bleach', 10), ('I-cleaning-cloth', 20)
)
INSERT OR IGNORE INTO stock_count_items
  (id, count_id, inventory_id, system_qty, counted_qty, variance, unit, reason, notes)
SELECT
  'SCI-est-' || e.inv_id, 'SC-estimate-001', e.inv_id,
  COALESCE(i.stock, 0), e.qty, e.qty - COALESCE(i.stock, 0), i.unit,
  'ESTIMATE — not physically counted', NULL
FROM est e JOIN inventory i ON i.id = e.inv_id;

-- Balances, derived from the movements just written so `stock` cannot disagree
-- with SUM(qty) over the ledger — the property the whole design rests on.
UPDATE inventory
   SET stock = (SELECT COALESCE(SUM(m.qty), 0) FROM stock_movements m WHERE m.inventory_id = inventory.id),
       stock_estimated = 1,
       updated_at = datetime('now')
 WHERE id IN (SELECT inventory_id FROM stock_count_items WHERE count_id = 'SC-estimate-001');

-- Beef keeps its measured figure and its flag stays clear.
UPDATE inventory SET stock_estimated = 0 WHERE id = 'I-beef';

INSERT OR IGNORE INTO audit_log
  (id, at, actor_id, actor_name, actor_role, action, entity, entity_id, before, after, reason)
VALUES
  ('AL-seed005-estimate', datetime('now'), NULL, 'system (seed 005)', 'system', 'adjust',
   'stock_counts', 'SC-estimate-001', '{"stock":0}', '{"stock":"estimated","items":72}',
   'Estimated opening stock entered at the business''s instruction pending a physical count. NOT COUNTED. Movements typed as adjustment rather than count; every item flagged stock_estimated = 1; reorder points left unset so no purchasing decision can be driven by these figures.');
