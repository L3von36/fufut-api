-- 010 — mark a recipe as provisional.
--
-- A recipe entered from an estimate rather than a measurement is still a
-- working recipe: it consumes stock, costs the dish and drives margin. What it
-- is not is *true*, and the difference has to survive being forgotten.
--
-- The same pattern as `payroll_runs.provisional`, for the same reason. A number
-- computed from figures nobody has confirmed must not look authoritative, and a
-- note in a commit message is not a control — six weeks from now the person
-- reading a food-cost report will not have read this file.
--
-- Cleared per recipe as the kitchen confirms each one, so it doubles as the
-- worklist: "which of these has anybody actually checked".
--
-- Apply with:
--   npx wrangler d1 execute fufut-db --remote --file=migrations/010-recipe-provisional.sql

ALTER TABLE recipes ADD COLUMN provisional INTEGER DEFAULT 0;

-- Reading "what still needs confirming" is the common query, and it is asked
-- of the active set only.
CREATE INDEX IF NOT EXISTS idx_recipes_provisional
  ON recipes(provisional, status) WHERE provisional = 1;
