-- SEED 001 — the raw-material catalogue.
--
-- This is a *catalogue*, not a stocktake. Every item is created with
-- **stock = 0 and cost = 0**, deliberately, because neither figure is knowable
-- from outside the building.
--
-- ── Why no quantities ───────────────────────────────────────────────────────
--
-- Stock is set by a purchase or a physical count, never by typing a number —
-- that is the whole point of the ledger (§22, §27). Seeding an invented opening
-- balance would put a fictional quantity into the first movement and every
-- variance calculation would measure against it forever.
--
-- Cost is left at 0 rather than guessed. An uncosted item reports a *null*
-- margin, not a 100% one: `productPerformance` treats `cost > 0` as the test
-- for whether a dish is costed at all, and the Recipes screen lists uncosted
-- dishes explicitly. A guessed price per kg would silently produce a food-cost
-- percentage that looks authoritative and is fiction. avg_cost fills in from
-- the first purchase received, which is the correct source.
--
-- ── Where this list comes from ──────────────────────────────────────────────
--
-- The item names, categories and units are derived from two things that *are*
-- knowable: §19/§20 of the specification, which lists what Fufut buys and in
-- what unit, and the 45 dishes actually on the menu in production — Bozena
-- Shero needs shiro powder, Teff Chechebsa needs teff flour, Tuna Salad needs
-- tuna, and so on.
--
-- What is NOT here, because it cannot be derived: recipes. How much coffee is
-- in a Fufut macchiato, and what goes into a Fufut Dulet, is knowledge the head
-- chef has and this file must not invent — see RECIPE-TEMPLATE.md.
--
-- Apply with:
--   npx wrangler d1 execute fufut-db --remote --file=migrations/seed-001-raw-materials.sql
--
-- Safe to re-run: every insert is OR IGNORE on the primary key.

-- ─────────────────────────────────────────────────────────────────────────────
-- Coffee, tea and infusions
-- ─────────────────────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO inventory (id, name, category, stock, unit, min_level, cost, is_packaging, track_expiry, active, created) VALUES
  ('I-coffee-beans', 'Coffee beans',       'Coffee & Tea', 0, 'kg',     0, 0, 0, 0, 1, datetime('now')),
  ('I-tea-leaves',   'Tea leaves',         'Coffee & Tea', 0, 'kg',     0, 0, 0, 0, 1, datetime('now')),
  ('I-ginger',       'Ginger',             'Coffee & Tea', 0, 'kg',     0, 0, 0, 1, 1, datetime('now')),
  ('I-honey',        'Honey',              'Coffee & Tea', 0, 'kg',     0, 0, 0, 0, 1, datetime('now')),

-- ─────────────────────────────────────────────────────────────────────────────
-- Dairy and eggs — perishable, so batch/expiry tracked (§37)
-- ─────────────────────────────────────────────────────────────────────────────
  ('I-milk',         'Milk',               'Dairy & Eggs', 0, 'litre',  0, 0, 0, 1, 1, datetime('now')),
  ('I-eggs',         'Eggs',               'Dairy & Eggs', 0, 'piece',  0, 0, 0, 1, 1, datetime('now')),
  ('I-butter',       'Niter kibbeh / butter','Dairy & Eggs',0,'kg',     0, 0, 0, 1, 1, datetime('now')),
  ('I-cheese',       'Cheese (ayib)',      'Dairy & Eggs', 0, 'kg',     0, 0, 0, 1, 1, datetime('now')),

-- ─────────────────────────────────────────────────────────────────────────────
-- Staples — injera and bread are counted, not weighed (§20)
-- ─────────────────────────────────────────────────────────────────────────────
  ('I-injera',       'Injera',             'Staples',      0, 'piece',  0, 0, 0, 1, 1, datetime('now')),
  ('I-bread',        'Bread',              'Staples',      0, 'piece',  0, 0, 0, 1, 1, datetime('now')),
  ('I-teff-flour',   'Teff flour',         'Staples',      0, 'kg',     0, 0, 0, 0, 1, datetime('now')),
  ('I-wheat-flour',  'Wheat flour',        'Staples',      0, 'kg',     0, 0, 0, 0, 1, datetime('now')),
  ('I-pasta',        'Pasta',              'Staples',      0, 'kg',     0, 0, 0, 0, 1, datetime('now')),
  ('I-rice',         'Rice',               'Staples',      0, 'kg',     0, 0, 0, 0, 1, datetime('now')),

-- ─────────────────────────────────────────────────────────────────────────────
-- Proteins and pulses
-- ─────────────────────────────────────────────────────────────────────────────
  ('I-beef',         'Beef',               'Proteins',     0, 'kg',     0, 0, 0, 1, 1, datetime('now')),
  ('I-chicken',      'Chicken',            'Proteins',     0, 'kg',     0, 0, 0, 1, 1, datetime('now')),
  ('I-lamb',         'Lamb / goat',        'Proteins',     0, 'kg',     0, 0, 0, 1, 1, datetime('now')),
  ('I-tuna',         'Tuna',               'Proteins',     0, 'piece',  0, 0, 0, 0, 1, datetime('now')),
  ('I-shiro',        'Shiro powder',       'Proteins',     0, 'kg',     0, 0, 0, 0, 1, datetime('now')),
  ('I-lentils',      'Lentils (misir)',    'Proteins',     0, 'kg',     0, 0, 0, 0, 1, datetime('now')),
  ('I-fava',         'Fava beans (ful)',   'Proteins',     0, 'kg',     0, 0, 0, 0, 1, datetime('now')),
  ('I-chickpeas',    'Chickpeas (shimbra)','Proteins',     0, 'kg',     0, 0, 0, 0, 1, datetime('now')),

-- ─────────────────────────────────────────────────────────────────────────────
-- Vegetables — perishable
-- ─────────────────────────────────────────────────────────────────────────────
  ('I-onion',        'Onion',              'Vegetables',   0, 'kg',     0, 0, 0, 1, 1, datetime('now')),
  ('I-tomato',       'Tomato',             'Vegetables',   0, 'kg',     0, 0, 0, 1, 1, datetime('now')),
  ('I-garlic',       'Garlic',             'Vegetables',   0, 'kg',     0, 0, 0, 1, 1, datetime('now')),
  ('I-green-pepper', 'Green pepper',       'Vegetables',   0, 'kg',     0, 0, 0, 1, 1, datetime('now')),
  ('I-lettuce',      'Lettuce / greens',   'Vegetables',   0, 'kg',     0, 0, 0, 1, 1, datetime('now')),
  ('I-cabbage',      'Cabbage',            'Vegetables',   0, 'kg',     0, 0, 0, 1, 1, datetime('now')),
  ('I-carrot',       'Carrot',             'Vegetables',   0, 'kg',     0, 0, 0, 1, 1, datetime('now')),
  ('I-potato',       'Potato',             'Vegetables',   0, 'kg',     0, 0, 0, 1, 1, datetime('now')),
  ('I-beetroot',     'Beetroot',           'Vegetables',   0, 'kg',     0, 0, 0, 1, 1, datetime('now')),
  ('I-cucumber',     'Cucumber',           'Vegetables',   0, 'kg',     0, 0, 0, 1, 1, datetime('now')),

-- ─────────────────────────────────────────────────────────────────────────────
-- Fruit — the juice menu and the fruit salad
-- ─────────────────────────────────────────────────────────────────────────────
  ('I-pineapple',    'Pineapple',          'Fruit',        0, 'kg',     0, 0, 0, 1, 1, datetime('now')),
  ('I-mango',        'Mango',              'Fruit',        0, 'kg',     0, 0, 0, 1, 1, datetime('now')),
  ('I-watermelon',   'Watermelon',         'Fruit',        0, 'kg',     0, 0, 0, 1, 1, datetime('now')),
  ('I-orange',       'Orange',             'Fruit',        0, 'kg',     0, 0, 0, 1, 1, datetime('now')),
  ('I-strawberry',   'Strawberry',         'Fruit',        0, 'kg',     0, 0, 0, 1, 1, datetime('now')),
  ('I-lemon',        'Lemon',              'Fruit',        0, 'kg',     0, 0, 0, 1, 1, datetime('now')),
  ('I-avocado',      'Avocado',            'Fruit',        0, 'kg',     0, 0, 0, 1, 1, datetime('now')),
  ('I-banana',       'Banana',             'Fruit',        0, 'kg',     0, 0, 0, 1, 1, datetime('now')),
  ('I-papaya',       'Papaya',             'Fruit',        0, 'kg',     0, 0, 0, 1, 1, datetime('now')),

-- ─────────────────────────────────────────────────────────────────────────────
-- Oil, sugar and spice
-- ─────────────────────────────────────────────────────────────────────────────
  ('I-oil',          'Cooking oil',        'Oil & Spice',  0, 'litre',  0, 0, 0, 0, 1, datetime('now')),
  ('I-sugar',        'Sugar',              'Oil & Spice',  0, 'kg',     0, 0, 0, 0, 1, datetime('now')),
  ('I-salt',         'Salt',               'Oil & Spice',  0, 'kg',     0, 0, 0, 0, 1, datetime('now')),
  ('I-berbere',      'Berbere',            'Oil & Spice',  0, 'kg',     0, 0, 0, 0, 1, datetime('now')),
  ('I-mitmita',      'Mitmita',            'Oil & Spice',  0, 'kg',     0, 0, 0, 0, 1, datetime('now')),
  ('I-black-pepper', 'Black pepper',       'Oil & Spice',  0, 'kg',     0, 0, 0, 0, 1, datetime('now')),
  ('I-cardamom',     'Cardamom',           'Oil & Spice',  0, 'kg',     0, 0, 0, 0, 1, datetime('now')),
  ('I-tomato-paste', 'Tomato paste',       'Oil & Spice',  0, 'kg',     0, 0, 0, 0, 1, datetime('now')),

-- ─────────────────────────────────────────────────────────────────────────────
-- Bought in for resale — sold as-is, so a recipe is one unit of itself
-- ─────────────────────────────────────────────────────────────────────────────
  ('I-soft-drink',   'Soft drink (Coca/Sprite/Fanta/Pepsi)','Bought In',0,'bottle',0,0,0,0,1,datetime('now')),
  ('I-malt',         'Malt drink',         'Bought In',    0, 'bottle', 0, 0, 0, 0, 1, datetime('now')),
  ('I-water-500',    'Mineral water 0.5L', 'Bought In',    0, 'bottle', 0, 0, 0, 0, 1, datetime('now')),
  ('I-water-1l',     'Mineral water 1L',   'Bought In',    0, 'bottle', 0, 0, 0, 0, 1, datetime('now')),
  ('I-water-2l',     'Mineral water 2L',   'Bought In',    0, 'bottle', 0, 0, 0, 0, 1, datetime('now')),
  ('I-sparkling',    'Sparkling water',    'Bought In',    0, 'bottle', 0, 0, 0, 0, 1, datetime('now')),

-- ─────────────────────────────────────────────────────────────────────────────
-- Fuel
-- ─────────────────────────────────────────────────────────────────────────────
  ('I-charcoal',     'Charcoal',           'Fuel',         0, 'kg',     0, 0, 0, 0, 1, datetime('now')),
  ('I-gas',          'Gas cylinder',       'Fuel',         0, 'piece',  0, 0, 0, 0, 1, datetime('now')),

-- ─────────────────────────────────────────────────────────────────────────────
-- Packaging (§6) — is_packaging = 1, so it is consumed on takeaway and
-- delivery and skipped for dine-in, and costed separately on the menu.
-- ─────────────────────────────────────────────────────────────────────────────
  ('I-box-small',    'Food container (small)','Packaging', 0, 'piece',  0, 0, 1, 0, 1, datetime('now')),
  ('I-box-large',    'Food container (large)','Packaging', 0, 'piece',  0, 0, 1, 0, 1, datetime('now')),
  ('I-coffee-cup',   'Coffee cup',         'Packaging',    0, 'piece',  0, 0, 1, 0, 1, datetime('now')),
  ('I-tea-cup',      'Tea cup',            'Packaging',    0, 'piece',  0, 0, 1, 0, 1, datetime('now')),
  ('I-plastic-cup',  'Plastic cup',        'Packaging',    0, 'piece',  0, 0, 1, 0, 1, datetime('now')),
  ('I-lid',          'Lid',                'Packaging',    0, 'piece',  0, 0, 1, 0, 1, datetime('now')),
  ('I-paper-bag',    'Paper bag',          'Packaging',    0, 'piece',  0, 0, 1, 0, 1, datetime('now')),
  ('I-plastic-bag',  'Plastic bag',        'Packaging',    0, 'piece',  0, 0, 1, 0, 1, datetime('now')),
  ('I-spoon',        'Spoon',              'Packaging',    0, 'piece',  0, 0, 1, 0, 1, datetime('now')),
  ('I-fork',         'Fork',               'Packaging',    0, 'piece',  0, 0, 1, 0, 1, datetime('now')),
  ('I-knife',        'Knife',              'Packaging',    0, 'piece',  0, 0, 1, 0, 1, datetime('now')),
  ('I-napkin',       'Napkin',             'Packaging',    0, 'piece',  0, 0, 1, 0, 1, datetime('now')),
  ('I-straw',        'Straw',              'Packaging',    0, 'piece',  0, 0, 1, 0, 1, datetime('now')),

-- ─────────────────────────────────────────────────────────────────────────────
-- Cleaning and other supplies
-- ─────────────────────────────────────────────────────────────────────────────
  ('I-dish-soap',    'Dish soap',          'Cleaning',     0, 'litre',  0, 0, 0, 0, 1, datetime('now')),
  ('I-bleach',       'Bleach / sanitiser', 'Cleaning',     0, 'litre',  0, 0, 0, 0, 1, datetime('now')),
  ('I-cleaning-cloth','Cleaning cloth',    'Cleaning',     0, 'piece',  0, 0, 0, 0, 1, datetime('now'));

-- Shelf life for the perishables, so "expiring soon" has something to work from
-- once batches start arriving. These are ordinary storage lives, and the kitchen
-- should correct any that do not match how Fufut actually stores them.
UPDATE inventory SET shelf_life_days = 5   WHERE id IN ('I-milk','I-injera');
UPDATE inventory SET shelf_life_days = 3   WHERE id IN ('I-beef','I-chicken','I-lamb');
UPDATE inventory SET shelf_life_days = 21  WHERE id = 'I-eggs';
UPDATE inventory SET shelf_life_days = 7   WHERE id IN ('I-lettuce','I-cucumber','I-tomato','I-strawberry','I-banana','I-papaya','I-avocado','I-mango');
UPDATE inventory SET shelf_life_days = 14  WHERE id IN ('I-onion','I-carrot','I-cabbage','I-potato','I-beetroot','I-orange','I-lemon','I-pineapple','I-watermelon');
UPDATE inventory SET shelf_life_days = 2   WHERE id = 'I-bread';
