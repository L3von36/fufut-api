-- SEED 004 — the draft recipes, entered as estimates.
--
-- ⚠ EVERY QUANTITY IN THIS FILE IS A GUESS.
--
-- These were drafted in RECIPE-DRAFT.md as starting points for the kitchen to
-- correct, and entered unconfirmed at the business's explicit instruction so
-- the engine has something to work with. They are marked `provisional = 1` and
-- every one says so in its notes, because the distinction between "estimated"
-- and "measured" has to survive being forgotten.
--
-- ── What they will do, correctly ───────────────────────────────────────────
--
-- Consume stock on every sale, cost each dish, and produce margin figures. The
-- machinery is right; the inputs are approximate.
--
-- ── What they will do, wrongly ─────────────────────────────────────────────
--
-- Every estimate that is off produces a steady one-directional variance. That
-- is the intended mechanism — §21's actual-vs-theoretical comparison is exactly
-- the tool for finding which of these are wrong — but until each is checked,
-- a variance against a *guessed* expectation says nothing about the kitchen.
-- Nobody should be asked about a discrepancy on a dish still marked
-- provisional.
--
-- Clear the flag per recipe as the chef confirms it:
--   UPDATE recipes SET provisional = 0 WHERE id = 'RC-tibs';
--
-- ── Not included ───────────────────────────────────────────────────────────
--
-- The four juices, because yield depends entirely on the fruit and on how much
-- water and sugar is added — a number there would be invention, not estimation.
-- Packaging lines, because which container each dish uses is a counter decision
-- nobody has made yet.
--
-- Apply with:
--   npx wrangler d1 execute fufut-db --remote --file=migrations/seed-004-draft-recipes.sql
--
-- Requires 010. Safe to re-run: OR IGNORE, and the partial unique index already
-- prevents a second active recipe per dish.

-- ─────────────────────────────────────────────────────────────────────────────
-- Recipes
-- ─────────────────────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO recipes
  (id, menu_item_id, name, variant, version, status, provisional, yield_qty, yield_unit,
   notes, effective_from, created_by_name, created_at)
VALUES
  ('RC-macchiato',  'MIb7a7a330', 'Macchiato',                      NULL, 1, 'active', 1, 1, 'serving', 'DRAFT — estimated, not measured. Confirm with the kitchen.', datetime('now'), 'system (seed 004)', datetime('now')),
  ('RC-espresso',   'MIe6d19d99', 'Espresso',                       NULL, 1, 'active', 1, 1, 'serving', 'DRAFT — estimated, not measured. Confirm with the kitchen.', datetime('now'), 'system (seed 004)', datetime('now')),
  ('RC-flatwhite',  'MI57a686f7', 'Flat White',                     NULL, 1, 'active', 1, 1, 'serving', 'DRAFT — estimated, not measured. Confirm with the kitchen.', datetime('now'), 'system (seed 004)', datetime('now')),
  ('RC-tradcoffee', 'MIbc2a1f02', 'Tridintional coffee',            NULL, 1, 'active', 1, 1, 'serving', 'DRAFT — estimated, not measured. Confirm with the kitchen.', datetime('now'), 'system (seed 004)', datetime('now')),
  ('RC-stemcoffee', 'MI283879b8', 'STEM Coffee',                    NULL, 1, 'active', 1, 1, 'serving', 'DRAFT — estimated, not measured. Confirm with the kitchen.', datetime('now'), 'system (seed 004)', datetime('now')),
  ('RC-tea',        'MIb54a9f4d', 'TEA',                            NULL, 1, 'active', 1, 1, 'serving', 'DRAFT — estimated, not measured. Confirm with the kitchen.', datetime('now'), 'system (seed 004)', datetime('now')),
  ('RC-futtea',     'MI3a1e9659', 'FUT Special tea',                NULL, 1, 'active', 1, 1, 'serving', 'DRAFT — estimated, not measured. Confirm with the kitchen.', datetime('now'), 'system (seed 004)', datetime('now')),
  ('RC-lemontea',   'MIe232b662', 'Lemon Tea',                      NULL, 1, 'active', 1, 1, 'serving', 'DRAFT — estimated, not measured. Confirm with the kitchen.', datetime('now'), 'system (seed 004)', datetime('now')),
  ('RC-gingerhoney','MI3a673ba8', 'Ginger with Honey',              NULL, 1, 'active', 1, 1, 'serving', 'DRAFT — estimated, not measured. Confirm with the kitchen.', datetime('now'), 'system (seed 004)', datetime('now')),

  ('RC-tibs',       'MIb8b47ce4', 'Tibs',                           NULL, 1, 'active', 1, 1, 'serving', 'DRAFT — estimated, not measured. Confirm with the kitchen.', datetime('now'), 'system (seed 004)', datetime('now')),
  ('RC-normaltibs', 'MIf1858f30', 'Normal ETHIOPIAN TIBS',          NULL, 1, 'active', 1, 1, 'serving', 'DRAFT — estimated, not measured. Confirm with the kitchen.', datetime('now'), 'system (seed 004)', datetime('now')),
  ('RC-chickentibs','MId2df18ef', 'AUTHENTIC ETHIOPIAN CHIKEA TIBS',NULL, 1, 'active', 1, 1, 'serving', 'DRAFT — estimated, not measured. Confirm with the kitchen.', datetime('now'), 'system (seed 004)', datetime('now')),
  ('RC-shirowat',   'MIfbc0c841', 'Shiro Wat',                      NULL, 1, 'active', 1, 1, 'serving', 'DRAFT — estimated, not measured. Confirm with the kitchen.', datetime('now'), 'system (seed 004)', datetime('now')),
  ('RC-bozena',     'MIdc67f6b2', 'BOZENA SHERO',                   NULL, 1, 'active', 1, 1, 'serving', 'DRAFT — estimated, not measured. Confirm with the kitchen.', datetime('now'), 'system (seed 004)', datetime('now')),
  -- Flagged in the draft as least reliable: what goes on the platter varies by
  -- house and by fasting day.
  ('RC-beyeaynet',  'MIe27ec2f4', 'Beyeaynet',                      NULL, 1, 'active', 1, 1, 'serving', 'DRAFT — estimated, and the least reliable of these. Platter contents vary by house and fasting day. Rewrite rather than adjust.', datetime('now'), 'system (seed 004)', datetime('now')),
  ('RC-futgebeta',  'MIf552585e', 'Fut Special Gebeta',             NULL, 1, 'active', 1, 1, 'serving', 'DRAFT — estimated, and the least reliable of these. Platter contents vary. NOTE: this dish exists twice on the menu; the duplicate is MIf552585e-1.', datetime('now'), 'system (seed 004)', datetime('now')),
  ('RC-futgebeta2', 'MIf552585e-1','Fut Special Gebeta (duplicate)',NULL, 1, 'active', 1, 1, 'serving', 'DRAFT — duplicate menu entry of Fut Special Gebeta. Same recipe so stock moves whichever is rung up. Merge the two menu items and this becomes redundant.', datetime('now'), 'system (seed 004)', datetime('now')),
  ('RC-pasta',      'MI93814680', 'PASTA TOMATO/ ALARRBIATA SAUCE', NULL, 1, 'active', 1, 1, 'serving', 'DRAFT — estimated, not measured. Confirm with the kitchen.', datetime('now'), 'system (seed 004)', datetime('now')),
  ('RC-pizza',      'MI853a6686', 'Pizza',                          NULL, 1, 'active', 1, 1, 'serving', 'DRAFT — estimated, not measured. Confirm with the kitchen.', datetime('now'), 'system (seed 004)', datetime('now')),

  ('RC-futbreak',   'MIdc3ae00e', 'Fut breakfast Gebeta',           NULL, 1, 'active', 1, 1, 'serving', 'DRAFT — estimated, not measured. Confirm with the kitchen.', datetime('now'), 'system (seed 004)', datetime('now')),
  ('RC-dulet',      'MId302bcb6', 'Dulet',                          NULL, 1, 'active', 1, 1, 'serving', 'DRAFT — estimated, not measured. Confirm with the kitchen.', datetime('now'), 'system (seed 004)', datetime('now')),
  ('RC-foul',       'MI66973548', 'FOUL MADAM',                     NULL, 1, 'active', 1, 1, 'serving', 'DRAFT — estimated, not measured. Confirm with the kitchen.', datetime('now'), 'system (seed 004)', datetime('now')),
  ('RC-chechebsa',  'MI679300f0', 'CHECHEBSA',                      NULL, 1, 'active', 1, 1, 'serving', 'DRAFT — estimated, not measured. Confirm with the kitchen.', datetime('now'), 'system (seed 004)', datetime('now')),
  ('RC-teffchech',  'MI758405e3', 'TEFF CHECHEBSA',                 NULL, 1, 'active', 1, 1, 'serving', 'DRAFT — estimated, not measured. Confirm with the kitchen.', datetime('now'), 'system (seed 004)', datetime('now')),
  ('RC-omelette',   'MI12a9f9e5', 'Omelette',                       NULL, 1, 'active', 1, 1, 'serving', 'DRAFT — estimated, not measured. Confirm with the kitchen.', datetime('now'), 'system (seed 004)', datetime('now')),
  ('RC-scrambled',  'MI363b7b33', 'SCRAMBLED EGGS',                 NULL, 1, 'active', 1, 1, 'serving', 'DRAFT — estimated, not measured. Confirm with the kitchen.', datetime('now'), 'system (seed 004)', datetime('now')),
  ('RC-tibsfirfir', 'MIcb08f910', 'TIBES FIRIFIR',                  NULL, 1, 'active', 1, 1, 'serving', 'DRAFT — estimated, not measured. Confirm with the kitchen.', datetime('now'), 'system (seed 004)', datetime('now')),
  ('RC-dircosh',    'MIc415b68e', 'DIRCOSH FIRFIR',                 NULL, 1, 'active', 1, 1, 'serving', 'DRAFT — estimated, not measured. Confirm with the kitchen.', datetime('now'), 'system (seed 004)', datetime('now')),
  ('RC-dircoshqun', 'MIf0d0bebe', 'DIRCOSH FIRFIR WITH QUNATA',     NULL, 1, 'active', 1, 1, 'serving', 'DRAFT — estimated, not measured. Confirm with the kitchen.', datetime('now'), 'system (seed 004)', datetime('now')),
  ('RC-fastfirfir', 'MI759af236', 'FASTING FIRFIR',                 NULL, 1, 'active', 1, 1, 'serving', 'DRAFT — estimated, not measured. Confirm with the kitchen.', datetime('now'), 'system (seed 004)', datetime('now')),
  ('RC-tegabino',   'MIe3b0fbb7', 'TEGABINO',                       NULL, 1, 'active', 1, 1, 'serving', 'DRAFT — estimated, not measured. Confirm with the kitchen.', datetime('now'), 'system (seed 004)', datetime('now')),

  ('RC-greensalad', 'MI8c029408', 'MIXED GARDEN GREEN SALAD',       NULL, 1, 'active', 1, 1, 'serving', 'DRAFT — estimated, not measured. Confirm with the kitchen.', datetime('now'), 'system (seed 004)', datetime('now')),
  ('RC-futsalad',   'MI86a8de9b', 'Fut special Salad',              NULL, 1, 'active', 1, 1, 'serving', 'DRAFT — estimated, not measured. Confirm with the kitchen.', datetime('now'), 'system (seed 004)', datetime('now')),
  ('RC-tunasalad',  'MIc0d7d819', 'TUNA SALAD',                     NULL, 1, 'active', 1, 1, 'serving', 'DRAFT — estimated, not measured. Confirm with the kitchen.', datetime('now'), 'system (seed 004)', datetime('now')),
  ('RC-fruitsalad', 'MI2be605e1', 'FRUIT SALAD',                    NULL, 1, 'active', 1, 1, 'serving', 'DRAFT — estimated, not measured. Confirm with the kitchen.', datetime('now'), 'system (seed 004)', datetime('now'));

-- ─────────────────────────────────────────────────────────────────────────────
-- Lines. Units are as the chef would write them (g, ml, piece); the engine
-- converts into each item's stocking unit at consumption.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO recipe_items
  (id, recipe_id, inventory_id, qty, unit, is_packaging, waste_pct, optional, sort_order, notes)
VALUES
  -- Hot drinks
  ('RI-macc-1','RC-macchiato','I-coffee-beans',18,'g',0,0,0,0,NULL),
  ('RI-macc-2','RC-macchiato','I-milk',120,'ml',0,0,0,1,NULL),
  ('RI-macc-3','RC-macchiato','I-sugar',5,'g',0,0,0,2,NULL),

  ('RI-esp-1','RC-espresso','I-coffee-beans',9,'g',0,0,0,0,NULL),
  ('RI-esp-2','RC-espresso','I-sugar',5,'g',0,0,0,1,NULL),

  ('RI-fw-1','RC-flatwhite','I-coffee-beans',18,'g',0,0,0,0,NULL),
  ('RI-fw-2','RC-flatwhite','I-milk',150,'ml',0,0,0,1,NULL),

  ('RI-trad-1','RC-tradcoffee','I-coffee-beans',30,'g',0,0,0,0,NULL),
  ('RI-trad-2','RC-tradcoffee','I-sugar',10,'g',0,0,0,1,NULL),

  ('RI-stem-1','RC-stemcoffee','I-coffee-beans',18,'g',0,0,0,0,NULL),
  ('RI-stem-2','RC-stemcoffee','I-milk',100,'ml',0,0,0,1,NULL),
  ('RI-stem-3','RC-stemcoffee','I-sugar',5,'g',0,0,0,2,NULL),

  ('RI-tea-1','RC-tea','I-tea-leaves',5,'g',0,0,0,0,NULL),
  ('RI-tea-2','RC-tea','I-sugar',10,'g',0,0,0,1,NULL),

  ('RI-futtea-1','RC-futtea','I-tea-leaves',5,'g',0,0,0,0,NULL),
  ('RI-futtea-2','RC-futtea','I-ginger',5,'g',0,0,0,1,NULL),
  ('RI-futtea-3','RC-futtea','I-cardamom',1,'g',0,0,0,2,NULL),
  ('RI-futtea-4','RC-futtea','I-sugar',10,'g',0,0,0,3,NULL),

  ('RI-lemtea-1','RC-lemontea','I-tea-leaves',5,'g',0,0,0,0,NULL),
  ('RI-lemtea-2','RC-lemontea','I-lemon',30,'g',0,0,0,1,NULL),
  ('RI-lemtea-3','RC-lemontea','I-sugar',10,'g',0,0,0,2,NULL),

  ('RI-ging-1','RC-gingerhoney','I-ginger',15,'g',0,0,0,0,NULL),
  ('RI-ging-2','RC-gingerhoney','I-honey',20,'g',0,0,0,1,NULL),
  ('RI-ging-3','RC-gingerhoney','I-lemon',15,'g',0,0,0,2,NULL),

  -- Ethiopian dishes
  ('RI-tibs-1','RC-tibs','I-beef',200,'g',0,0,0,0,NULL),
  ('RI-tibs-2','RC-tibs','I-onion',60,'g',0,0,0,1,NULL),
  ('RI-tibs-3','RC-tibs','I-green-pepper',20,'g',0,0,0,2,NULL),
  ('RI-tibs-4','RC-tibs','I-butter',20,'g',0,0,0,3,NULL),
  ('RI-tibs-5','RC-tibs','I-injera',2,'piece',0,0,0,4,NULL),

  ('RI-ntibs-1','RC-normaltibs','I-beef',200,'g',0,0,0,0,NULL),
  ('RI-ntibs-2','RC-normaltibs','I-onion',60,'g',0,0,0,1,NULL),
  ('RI-ntibs-3','RC-normaltibs','I-green-pepper',20,'g',0,0,0,2,NULL),
  ('RI-ntibs-4','RC-normaltibs','I-butter',20,'g',0,0,0,3,NULL),
  ('RI-ntibs-5','RC-normaltibs','I-injera',2,'piece',0,0,0,4,NULL),

  ('RI-ctibs-1','RC-chickentibs','I-chicken',220,'g',0,0,0,0,NULL),
  ('RI-ctibs-2','RC-chickentibs','I-onion',60,'g',0,0,0,1,NULL),
  ('RI-ctibs-3','RC-chickentibs','I-green-pepper',20,'g',0,0,0,2,NULL),
  ('RI-ctibs-4','RC-chickentibs','I-oil',25,'ml',0,0,0,3,NULL),
  ('RI-ctibs-5','RC-chickentibs','I-injera',2,'piece',0,0,0,4,NULL),

  ('RI-shiro-1','RC-shirowat','I-shiro',80,'g',0,0,0,0,NULL),
  ('RI-shiro-2','RC-shirowat','I-onion',40,'g',0,0,0,1,NULL),
  ('RI-shiro-3','RC-shirowat','I-oil',30,'ml',0,0,0,2,NULL),
  ('RI-shiro-4','RC-shirowat','I-injera',2,'piece',0,0,0,3,NULL),

  ('RI-boz-1','RC-bozena','I-shiro',70,'g',0,0,0,0,NULL),
  ('RI-boz-2','RC-bozena','I-beef',80,'g',0,0,0,1,NULL),
  ('RI-boz-3','RC-bozena','I-onion',40,'g',0,0,0,2,NULL),
  ('RI-boz-4','RC-bozena','I-butter',20,'g',0,0,0,3,NULL),
  ('RI-boz-5','RC-bozena','I-injera',2,'piece',0,0,0,4,NULL),

  ('RI-bey-1','RC-beyeaynet','I-shiro',50,'g',0,0,0,0,NULL),
  ('RI-bey-2','RC-beyeaynet','I-lentils',60,'g',0,0,0,1,NULL),
  ('RI-bey-3','RC-beyeaynet','I-cabbage',60,'g',0,0,0,2,NULL),
  ('RI-bey-4','RC-beyeaynet','I-carrot',40,'g',0,0,0,3,NULL),
  ('RI-bey-5','RC-beyeaynet','I-potato',60,'g',0,0,0,4,NULL),
  ('RI-bey-6','RC-beyeaynet','I-oil',30,'ml',0,0,0,5,NULL),
  ('RI-bey-7','RC-beyeaynet','I-injera',3,'piece',0,0,0,6,NULL),

  ('RI-fgeb-1','RC-futgebeta','I-beef',120,'g',0,0,0,0,NULL),
  ('RI-fgeb-2','RC-futgebeta','I-shiro',50,'g',0,0,0,1,NULL),
  ('RI-fgeb-3','RC-futgebeta','I-lentils',50,'g',0,0,0,2,NULL),
  ('RI-fgeb-4','RC-futgebeta','I-cabbage',50,'g',0,0,0,3,NULL),
  ('RI-fgeb-5','RC-futgebeta','I-injera',3,'piece',0,0,0,4,NULL),

  ('RI-fgeb2-1','RC-futgebeta2','I-beef',120,'g',0,0,0,0,NULL),
  ('RI-fgeb2-2','RC-futgebeta2','I-shiro',50,'g',0,0,0,1,NULL),
  ('RI-fgeb2-3','RC-futgebeta2','I-lentils',50,'g',0,0,0,2,NULL),
  ('RI-fgeb2-4','RC-futgebeta2','I-cabbage',50,'g',0,0,0,3,NULL),
  ('RI-fgeb2-5','RC-futgebeta2','I-injera',3,'piece',0,0,0,4,NULL),

  ('RI-pasta-1','RC-pasta','I-pasta',120,'g',0,0,0,0,NULL),
  ('RI-pasta-2','RC-pasta','I-tomato-paste',50,'g',0,0,0,1,NULL),
  ('RI-pasta-3','RC-pasta','I-onion',30,'g',0,0,0,2,NULL),
  ('RI-pasta-4','RC-pasta','I-oil',20,'ml',0,0,0,3,NULL),

  ('RI-pizza-1','RC-pizza','I-wheat-flour',180,'g',0,0,0,0,NULL),
  ('RI-pizza-2','RC-pizza','I-tomato-paste',60,'g',0,0,0,1,NULL),
  ('RI-pizza-3','RC-pizza','I-cheese',80,'g',0,0,0,2,NULL),
  ('RI-pizza-4','RC-pizza','I-oil',15,'ml',0,0,0,3,NULL),

  -- Breakfast
  ('RI-fbrk-1','RC-futbreak','I-eggs',2,'piece',0,0,0,0,NULL),
  ('RI-fbrk-2','RC-futbreak','I-bread',1,'piece',0,0,0,1,NULL),
  ('RI-fbrk-3','RC-futbreak','I-tomato',40,'g',0,0,0,2,NULL),
  ('RI-fbrk-4','RC-futbreak','I-oil',15,'ml',0,0,0,3,NULL),

  ('RI-dul-1','RC-dulet','I-beef',150,'g',0,0,0,0,NULL),
  ('RI-dul-2','RC-dulet','I-butter',25,'g',0,0,0,1,NULL),
  ('RI-dul-3','RC-dulet','I-onion',40,'g',0,0,0,2,NULL),
  ('RI-dul-4','RC-dulet','I-injera',2,'piece',0,0,0,3,NULL),

  ('RI-foul-1','RC-foul','I-fava',150,'g',0,0,0,0,NULL),
  ('RI-foul-2','RC-foul','I-onion',40,'g',0,0,0,1,NULL),
  ('RI-foul-3','RC-foul','I-tomato',40,'g',0,0,0,2,NULL),
  ('RI-foul-4','RC-foul','I-oil',20,'ml',0,0,0,3,NULL),
  ('RI-foul-5','RC-foul','I-bread',1,'piece',0,0,0,4,NULL),

  ('RI-chech-1','RC-chechebsa','I-wheat-flour',120,'g',0,0,0,0,NULL),
  ('RI-chech-2','RC-chechebsa','I-butter',40,'g',0,0,0,1,NULL),
  ('RI-chech-3','RC-chechebsa','I-berbere',10,'g',0,0,0,2,NULL),

  ('RI-tchech-1','RC-teffchech','I-teff-flour',120,'g',0,0,0,0,NULL),
  ('RI-tchech-2','RC-teffchech','I-butter',40,'g',0,0,0,1,NULL),
  ('RI-tchech-3','RC-teffchech','I-berbere',10,'g',0,0,0,2,NULL),

  ('RI-om-1','RC-omelette','I-eggs',3,'piece',0,0,0,0,NULL),
  ('RI-om-2','RC-omelette','I-onion',30,'g',0,0,0,1,NULL),
  ('RI-om-3','RC-omelette','I-tomato',30,'g',0,0,0,2,NULL),
  ('RI-om-4','RC-omelette','I-oil',15,'ml',0,0,0,3,NULL),

  ('RI-scr-1','RC-scrambled','I-eggs',3,'piece',0,0,0,0,NULL),
  ('RI-scr-2','RC-scrambled','I-butter',15,'g',0,0,0,1,NULL),

  ('RI-tfir-1','RC-tibsfirfir','I-beef',120,'g',0,0,0,0,NULL),
  ('RI-tfir-2','RC-tibsfirfir','I-injera',3,'piece',0,0,0,1,NULL),
  ('RI-tfir-3','RC-tibsfirfir','I-berbere',15,'g',0,0,0,2,NULL),
  ('RI-tfir-4','RC-tibsfirfir','I-butter',25,'g',0,0,0,3,NULL),

  ('RI-dir-1','RC-dircosh','I-injera',3,'piece',0,0,0,0,NULL),
  ('RI-dir-2','RC-dircosh','I-berbere',15,'g',0,0,0,1,NULL),
  ('RI-dir-3','RC-dircosh','I-oil',25,'ml',0,0,0,2,NULL),
  ('RI-dir-4','RC-dircosh','I-onion',40,'g',0,0,0,3,NULL),

  ('RI-dirq-1','RC-dircoshqun','I-injera',3,'piece',0,0,0,0,NULL),
  ('RI-dirq-2','RC-dircoshqun','I-beef',60,'g',0,0,0,1,NULL),
  ('RI-dirq-3','RC-dircoshqun','I-berbere',15,'g',0,0,0,2,NULL),
  ('RI-dirq-4','RC-dircoshqun','I-butter',25,'g',0,0,0,3,NULL),

  ('RI-ffir-1','RC-fastfirfir','I-injera',3,'piece',0,0,0,0,NULL),
  ('RI-ffir-2','RC-fastfirfir','I-berbere',15,'g',0,0,0,1,NULL),
  ('RI-ffir-3','RC-fastfirfir','I-oil',30,'ml',0,0,0,2,NULL),
  ('RI-ffir-4','RC-fastfirfir','I-onion',40,'g',0,0,0,3,NULL),

  ('RI-teg-1','RC-tegabino','I-shiro',90,'g',0,0,0,0,NULL),
  ('RI-teg-2','RC-tegabino','I-oil',30,'ml',0,0,0,1,NULL),
  ('RI-teg-3','RC-tegabino','I-onion',30,'g',0,0,0,2,NULL),
  ('RI-teg-4','RC-tegabino','I-injera',2,'piece',0,0,0,3,NULL),

  -- Salads
  ('RI-gsal-1','RC-greensalad','I-lettuce',100,'g',0,0,0,0,NULL),
  ('RI-gsal-2','RC-greensalad','I-tomato',60,'g',0,0,0,1,NULL),
  ('RI-gsal-3','RC-greensalad','I-cucumber',60,'g',0,0,0,2,NULL),
  ('RI-gsal-4','RC-greensalad','I-onion',20,'g',0,0,0,3,NULL),

  ('RI-fsal-1','RC-futsalad','I-lettuce',80,'g',0,0,0,0,NULL),
  ('RI-fsal-2','RC-futsalad','I-tomato',50,'g',0,0,0,1,NULL),
  ('RI-fsal-3','RC-futsalad','I-cucumber',50,'g',0,0,0,2,NULL),
  ('RI-fsal-4','RC-futsalad','I-avocado',60,'g',0,0,0,3,NULL),
  ('RI-fsal-5','RC-futsalad','I-beetroot',40,'g',0,0,0,4,NULL),

  ('RI-tsal-1','RC-tunasalad','I-tuna',1,'piece',0,0,0,0,NULL),
  ('RI-tsal-2','RC-tunasalad','I-lettuce',80,'g',0,0,0,1,NULL),
  ('RI-tsal-3','RC-tunasalad','I-tomato',50,'g',0,0,0,2,NULL),
  ('RI-tsal-4','RC-tunasalad','I-onion',20,'g',0,0,0,3,NULL),

  ('RI-frsal-1','RC-fruitsalad','I-papaya',80,'g',0,0,0,0,NULL),
  ('RI-frsal-2','RC-fruitsalad','I-banana',60,'g',0,0,0,1,NULL),
  ('RI-frsal-3','RC-fruitsalad','I-mango',60,'g',0,0,0,2,NULL),
  ('RI-frsal-4','RC-fruitsalad','I-pineapple',60,'g',0,0,0,3,NULL);

-- ─────────────────────────────────────────────────────────────────────────────
-- Audit
-- ─────────────────────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO audit_log
  (id, at, actor_id, actor_name, actor_role, action, entity, entity_id, before, after, reason)
VALUES
  ('AL-seed004-recipes', datetime('now'), NULL, 'system (seed 004)', 'system', 'create',
   'recipes', NULL, NULL, '{"recipes":35,"provisional":true}',
   'Draft recipes entered as estimates at the business''s instruction, to give the engine a starting point. Every quantity is a guess; all marked provisional = 1 pending confirmation by the kitchen. A variance against a provisional recipe says nothing about the kitchen.');
