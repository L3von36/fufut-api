-- CFG 002 — the two "Fut Special Gebeta" entries are not duplicates.
--
-- ── Correcting an earlier misreading ───────────────────────────────────────
--
-- These were reported as a duplicated menu item with an accidental price
-- discrepancy, and the recommendation was to merge them. That was wrong, and
-- acting on it would have deleted a real dish. Their descriptions say plainly
-- that they are different platters:
--
--   MIf552585e   (1400)  Key Firfir, DULET, Alicha Firfir, scrambled eggs,
--                        Derkosh Firfir, TIBS, kale with RIBS MEAT
--   MIf552585e-1  (900)  Key Derkosh Firfir, Alicha Firfir, MISIR WOT,
--                        pasta with tomato, kale, fried vegetables
--
-- One is the meat platter; the other is the fasting (ye'tsom) version. The
-- 500 ETB difference is the meat. Nothing is duplicated and nothing should be
-- merged.
--
-- ── The real defect ────────────────────────────────────────────────────────
--
-- They share a name, so on the order screen they are indistinguishable. Which
-- one a waiter taps changes the bill by 500 ETB — and, far more seriously, a
-- guest fasting could be served the meat platter. Renaming is the fix; deleting
-- would have caused the harm.
--
-- ── And the recipe was wrong ───────────────────────────────────────────────
--
-- seed-004 gave both platters the same recipe, including 120 g of beef. On the
-- fasting version that is not an inaccurate estimate, it is a category error: a
-- fasting dish consuming meat would misreport stock every time one sold, and
-- would state in the system's own data that the dish contains meat.
--
-- Both recipes stay `provisional` — the contents below are read off the menu
-- descriptions, which is far better than the earlier guess but still not a
-- measurement.
--
-- Apply with:
--   npx wrangler d1 execute fufut-db --remote --file=migrations/cfg-002-gebeta-meat-vs-fasting.sql

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Names that can be told apart on a busy screen
-- ─────────────────────────────────────────────────────────────────────────────
-- "Fasting" is the menu's own vocabulary — it already lists FASTING FIRFIR — so
-- it needs no explaining to staff or guests.
UPDATE menu_items SET name = 'Fut Special Gebeta (Meat)'    WHERE id = 'MIf552585e';
UPDATE menu_items SET name = 'Fut Special Gebeta (Fasting)' WHERE id = 'MIf552585e-1';

UPDATE recipes SET name = 'Fut Special Gebeta (Meat)'    WHERE id = 'RC-futgebeta';
UPDATE recipes SET name = 'Fut Special Gebeta (Fasting)' WHERE id = 'RC-futgebeta2';

UPDATE recipes
   SET notes = 'DRAFT — contents read from the menu description. The meat platter: Key Firfir, Dulet, Alicha Firfir, scrambled eggs, Derkosh Firfir, Tibs, kale with ribs meat. Serves 2-3, so quantities are for the whole platter.'
 WHERE id = 'RC-futgebeta';

UPDATE recipes
   SET notes = 'DRAFT — contents read from the menu description. FASTING (ye''tsom): no meat, no eggs, no dairy. Misir wot, firfir, pasta with tomato, kale, fried vegetables. Serves 2-3, so quantities are for the whole platter.'
 WHERE id = 'RC-futgebeta2';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Rebuild both recipes from what the descriptions actually say
-- ─────────────────────────────────────────────────────────────────────────────
-- Replaced wholesale rather than adjusted: the fasting lines were wrong in kind,
-- not in degree.
DELETE FROM recipe_items WHERE recipe_id IN ('RC-futgebeta', 'RC-futgebeta2');

-- Meat platter, 1400 ETB, serves 2–3. Beef covers the dulet, the tibs and the
-- ribs meat, so it is well above a single portion.
INSERT OR IGNORE INTO recipe_items
  (id, recipe_id, inventory_id, qty, unit, is_packaging, waste_pct, optional, sort_order, notes)
VALUES
  ('RI-gebm-1','RC-futgebeta','I-beef',260,'g',0,0,0,0,'Dulet, tibs and ribs meat combined'),
  ('RI-gebm-2','RC-futgebeta','I-eggs',2,'piece',0,0,0,1,'Ethiopian scrambled eggs'),
  ('RI-gebm-3','RC-futgebeta','I-injera',4,'piece',0,0,0,2,'Firfir base plus serving'),
  ('RI-gebm-4','RC-futgebeta','I-butter',40,'g',0,0,0,3,NULL),
  ('RI-gebm-5','RC-futgebeta','I-berbere',20,'g',0,0,0,4,'Key firfir'),
  ('RI-gebm-6','RC-futgebeta','I-cabbage',60,'g',0,0,0,5,'Kale'),
  ('RI-gebm-7','RC-futgebeta','I-onion',60,'g',0,0,0,6,NULL),
  ('RI-gebm-8','RC-futgebeta','I-bread',1,'piece',0,0,0,7,'Wheat bread'),

  -- Fasting platter, 900 ETB, serves 2–3. No beef, no eggs, no butter — oil
  -- replaces the niter kibbeh, which is what makes the dish fasting at all.
  ('RI-gebf-1','RC-futgebeta2','I-lentils',100,'g',0,0,0,0,'Misir wot'),
  ('RI-gebf-2','RC-futgebeta2','I-pasta',80,'g',0,0,0,1,'Pasta with tomato'),
  ('RI-gebf-3','RC-futgebeta2','I-tomato-paste',40,'g',0,0,0,2,NULL),
  ('RI-gebf-4','RC-futgebeta2','I-injera',4,'piece',0,0,0,3,'Firfir base plus serving'),
  ('RI-gebf-5','RC-futgebeta2','I-berbere',20,'g',0,0,0,4,'Key derkosh firfir'),
  ('RI-gebf-6','RC-futgebeta2','I-cabbage',80,'g',0,0,0,5,'Kale'),
  ('RI-gebf-7','RC-futgebeta2','I-potato',60,'g',0,0,0,6,'Fried vegetables'),
  ('RI-gebf-8','RC-futgebeta2','I-carrot',50,'g',0,0,0,7,'Fried vegetables'),
  ('RI-gebf-9','RC-futgebeta2','I-onion',60,'g',0,0,0,8,NULL),
  ('RI-gebf-10','RC-futgebeta2','I-oil',60,'ml',0,0,0,9,'Not butter — fasting'),
  ('RI-gebf-11','RC-futgebeta2','I-bread',1,'piece',0,0,0,10,'Wheat bread or pita');

-- ─────────────────────────────────────────────────────────────────────────────
-- Audit
-- ─────────────────────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO audit_log
  (id, at, actor_id, actor_name, actor_role, action, entity, entity_id, before, after, reason)
VALUES
  ('AL-cfg002-gebeta-meat', datetime('now'), NULL, 'system (cfg 002)', 'system', 'update',
   'menu', 'MIf552585e', '{"name":"Fut Special Gebeta"}', '{"name":"Fut Special Gebeta (Meat)"}',
   'Renamed to distinguish from the fasting platter of the same name. Not a duplicate: different contents, different price.'),
  ('AL-cfg002-gebeta-fast', datetime('now'), NULL, 'system (cfg 002)', 'system', 'update',
   'menu', 'MIf552585e-1', '{"name":"Fut Special Gebeta"}', '{"name":"Fut Special Gebeta (Fasting)"}',
   'Renamed to distinguish from the meat platter of the same name. Two dishes shared a name, so which one a waiter tapped changed the bill by 500 ETB and a fasting guest could have been served meat.'),
  ('AL-cfg002-gebeta-recipe', datetime('now'), NULL, 'system (cfg 002)', 'system', 'update',
   'recipes', 'RC-futgebeta2', '{"beef_g":120}', '{"beef_g":0}',
   'Removed beef from the fasting platter. seed-004 gave both platters the same recipe; on the fasting version that was a category error, not an inaccurate estimate.');
