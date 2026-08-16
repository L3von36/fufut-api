-- SEED 002 — recipes for the six drinks bought in and resold.
--
-- A bottle of Coca sold consumes one bottle of Coca. Trivial arithmetic, but
-- without it those sales consume nothing at all and the fridge never appears to
-- empty: the reorder list would never flag soft drinks, the forecast would show
-- infinite cover, and the stock count would show a shortfall every single time
-- with nothing to explain it.
--
-- ── Why only these six ──────────────────────────────────────────────────────
--
-- These need no judgement — the recipe is one unit of the thing itself, and the
-- unit is a bottle either way. The other four drinks on the menu (Fut Detox
-- Juice, Seasonal fruit mix, the Pineapple/Mango/Watermelon/Orange juice, and
-- the Strawberry/Virgin Lemonade) are *made* from fruit and sugar in quantities
-- only the kitchen knows, so they are deliberately left without recipes rather
-- than guessed at. See RECIPE-TEMPLATE.md.
--
-- No packaging line is included. A takeaway bottle may well go in a bag, but
-- which packaging and how much is a decision for whoever runs the counter, and
-- inventing it here would quietly draw down bag stock on every dine-in bottle
-- too if it were ever mis-set.
--
-- Apply with:
--   npx wrangler d1 execute fufut-db --remote --file=migrations/seed-002-bought-in-drinks.sql
--
-- Safe to re-run: OR IGNORE on the primary keys. Note the partial unique index
-- idx_recipes_active_variant already prevents a second active recipe for the
-- same dish, so a re-run cannot create a duplicate that would make "which
-- recipe did we consume" ambiguous.

-- ─────────────────────────────────────────────────────────────────────────────
-- Recipes — one serving, no variant
-- ─────────────────────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO recipes
  (id, menu_item_id, name, variant, version, status, yield_qty, yield_unit,
   notes, effective_from, created_by_name, created_at)
VALUES
  ('RC-drink-soda',    'MIee0db54b', 'Sodas/Coca sprite Fanta Pepsi', NULL, 1, 'active', 1, 'serving',
   'Bought in and resold — one bottle per sale.', datetime('now'), 'system (seed 002)', datetime('now')),
  ('RC-drink-malt',    'MI50aa5f60', 'SINIQE MALTE',                  NULL, 1, 'active', 1, 'serving',
   'Bought in and resold — one bottle per sale.', datetime('now'), 'system (seed 002)', datetime('now')),
  ('RC-drink-w500',    'MI04c3d3fa', 'Mineral Water 0.5L',            NULL, 1, 'active', 1, 'serving',
   'Bought in and resold — one bottle per sale.', datetime('now'), 'system (seed 002)', datetime('now')),
  ('RC-drink-w1l',     'MI88f7c5b8', 'Mineral Water 1L',              NULL, 1, 'active', 1, 'serving',
   'Bought in and resold — one bottle per sale.', datetime('now'), 'system (seed 002)', datetime('now')),
  ('RC-drink-w2l',     'MI6ac3bb1b', 'Mineral Water 2L',              NULL, 1, 'active', 1, 'serving',
   'Bought in and resold — one bottle per sale.', datetime('now'), 'system (seed 002)', datetime('now')),
  ('RC-drink-sparkle', 'MIfa57d624', 'Sparkling water',               NULL, 1, 'active', 1, 'serving',
   'Bought in and resold — one bottle per sale.', datetime('now'), 'system (seed 002)', datetime('now'));

-- ─────────────────────────────────────────────────────────────────────────────
-- One line each: 1 bottle of itself.
-- ─────────────────────────────────────────────────────────────────────────────
-- The unit matches how the item is stocked, so no conversion is involved and
-- the engine's compatibility check passes trivially.
INSERT OR IGNORE INTO recipe_items
  (id, recipe_id, inventory_id, qty, unit, is_packaging, waste_pct, optional, sort_order, notes)
VALUES
  ('RI-drink-soda',    'RC-drink-soda',    'I-soft-drink', 1, 'bottle', 0, 0, 0, 0, NULL),
  ('RI-drink-malt',    'RC-drink-malt',    'I-malt',       1, 'bottle', 0, 0, 0, 0, NULL),
  ('RI-drink-w500',    'RC-drink-w500',    'I-water-500',  1, 'bottle', 0, 0, 0, 0, NULL),
  ('RI-drink-w1l',     'RC-drink-w1l',     'I-water-1l',   1, 'bottle', 0, 0, 0, 0, NULL),
  ('RI-drink-w2l',     'RC-drink-w2l',     'I-water-2l',   1, 'bottle', 0, 0, 0, 0, NULL),
  ('RI-drink-sparkle', 'RC-drink-sparkle', 'I-sparkling',  1, 'bottle', 0, 0, 0, 0, NULL);

-- ─────────────────────────────────────────────────────────────────────────────
-- Audit
-- ─────────────────────────────────────────────────────────────────────────────
-- These recipes were written straight to the database rather than through the
-- API, so nothing recorded them. The log is the place that answers "where did
-- this recipe come from" months later, and a seeded row that appears from
-- nowhere is exactly the kind of thing it exists to explain.
INSERT OR IGNORE INTO audit_log
  (id, at, actor_id, actor_name, actor_role, action, entity, entity_id, before, after, reason)
VALUES
  ('AL-seed002-soda',    datetime('now'), NULL, 'system (seed 002)', 'system', 'create', 'recipes', 'RC-drink-soda',    NULL, '{"menu_item_id":"MIee0db54b","lines":1}', 'Seeded: bought-in drink, 1 bottle per sale'),
  ('AL-seed002-malt',    datetime('now'), NULL, 'system (seed 002)', 'system', 'create', 'recipes', 'RC-drink-malt',    NULL, '{"menu_item_id":"MI50aa5f60","lines":1}', 'Seeded: bought-in drink, 1 bottle per sale'),
  ('AL-seed002-w500',    datetime('now'), NULL, 'system (seed 002)', 'system', 'create', 'recipes', 'RC-drink-w500',    NULL, '{"menu_item_id":"MI04c3d3fa","lines":1}', 'Seeded: bought-in drink, 1 bottle per sale'),
  ('AL-seed002-w1l',     datetime('now'), NULL, 'system (seed 002)', 'system', 'create', 'recipes', 'RC-drink-w1l',     NULL, '{"menu_item_id":"MI88f7c5b8","lines":1}', 'Seeded: bought-in drink, 1 bottle per sale'),
  ('AL-seed002-w2l',     datetime('now'), NULL, 'system (seed 002)', 'system', 'create', 'recipes', 'RC-drink-w2l',     NULL, '{"menu_item_id":"MI6ac3bb1b","lines":1}', 'Seeded: bought-in drink, 1 bottle per sale'),
  ('AL-seed002-sparkle', datetime('now'), NULL, 'system (seed 002)', 'system', 'create', 'recipes', 'RC-drink-sparkle', NULL, '{"menu_item_id":"MIfa57d624","lines":1}', 'Seeded: bought-in drink, 1 bottle per sale');
