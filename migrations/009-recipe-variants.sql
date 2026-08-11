-- 009 — per-variation recipes (§32).
--
-- A small, medium and large coffee do not use the same amount of coffee: the
-- spec's own example is 12 g / 18 g / 25 g. Recipes keyed on menu_item_id alone
-- meant all three sizes consumed the medium's quantity, so every small
-- over-consumed and every large under-consumed, and the variance report blamed
-- the kitchen for it.
--
-- ── Why the variant is matched against modifiers ────────────────────────────
--
-- Sizes are already modifiers on the menu item; production stores them as a
-- plain array of names (`["Hot"]`, `["warm or cold"]`). Rather than adding a
-- notion of "which modifier is a size" — which would need every existing menu
-- item re-tagged — a variant recipe simply carries the modifier's name. If a
-- line was ordered with a modifier matching a variant recipe, that recipe is
-- used; otherwise the item's default (variant IS NULL) applies.
--
-- The consequence worth stating: items with no variant recipes behave exactly
-- as they do today. This is opt-in per dish.
--
-- Apply with:
--   npx wrangler d1 execute fufut-db --remote --file=migrations/009-recipe-variants.sql

ALTER TABLE recipes ADD COLUMN variant TEXT;

-- The old index enforced one active recipe per menu item, which is now too
-- strict: a coffee legitimately has an active Small, Medium and Large. The
-- replacement enforces one active recipe per item *per variant*, so "which
-- recipe did we consume" stays unambiguous at the moment it must be recorded.
DROP INDEX IF EXISTS idx_recipes_active_item;

-- COALESCE, because SQLite treats every NULL as distinct in a unique index —
-- without it two active default recipes for the same dish would both be
-- allowed, which is exactly the ambiguity the original index prevented.
CREATE UNIQUE INDEX IF NOT EXISTS idx_recipes_active_variant
  ON recipes(menu_item_id, COALESCE(variant, ''))
  WHERE status = 'active' AND menu_item_id IS NOT NULL;

-- Reading "every active recipe for this dish" is now the common lookup, since
-- the variant is chosen in code from the line's modifiers.
CREATE INDEX IF NOT EXISTS idx_recipes_item_variant ON recipes(menu_item_id, variant, status);

-- The variant actually consumed, snapshotted onto the sold line beside
-- recipe_id. Without it a margin report cannot say whether the 25 g was a large
-- or a mis-costed medium.
ALTER TABLE order_items ADD COLUMN recipe_variant TEXT;
