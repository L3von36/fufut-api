-- CFG 001 — beef preparation yield set to 85%.
--
-- Trim, bone and fat mean 40 kg bought is not 40 kg on plates. 85% is the
-- figure the business gave; it is per-item configuration, never hard-coded,
-- exactly as §25 requires.
--
-- ── Which direction this works ─────────────────────────────────────────────
--
-- The recipe states what reaches the guest; stock holds what was bought. So a
-- 150 g portion now consumes 150 / 0.85 ≈ 176.5 g of stock — the engine
-- *divides* by the yield factor. Multiplying would be the intuitive-looking
-- mistake and would turn the specification's own worked example of 566 meals
-- into 784.
--
-- ── What changes as a result ───────────────────────────────────────────────
--
--   * Consumption per portion rises ~17.6%, so the shelf empties at the rate
--     it actually empties. The persistent negative variance that trimming
--     would otherwise produce — and which reads like waste or theft — goes
--     away, because it was never a discrepancy, only an unmodelled loss.
--   * Ingredient cost per portion rises with it: at 700 ETB/kg a 150 g portion
--     costs 123.53 ETB rather than 105. That is the true cost of putting it on
--     a plate, and gross margin on beef dishes falls accordingly. Lower and
--     correct beats higher and wrong.
--   * Theoretical capacity falls. 40 kg at 150 g a portion: 266 → 226.
--
-- Nothing already sold is affected. order_items snapshots ingredient_cost at
-- the moment of consumption, so past sales keep the cost they were made at —
-- the same rule that governs recipe versions.
--
-- Apply with:
--   npx wrangler d1 execute fufut-db --remote --file=migrations/cfg-001-beef-prep-yield.sql

UPDATE inventory
   SET yield_pct = 85,
       updated_at = datetime('now')
 WHERE id = 'I-beef';

-- Audited: this silently changes every future consumption and cost figure for
-- beef, which is precisely the kind of change that has to be answerable months
-- later when somebody asks why the food cost moved.
INSERT OR IGNORE INTO audit_log
  (id, at, actor_id, actor_name, actor_role, action, entity, entity_id, before, after, reason)
VALUES
  ('AL-cfg001-beef-yield', datetime('now'), NULL, 'system (cfg 001)', 'system', 'update',
   'inventory', 'I-beef', '{"yield_pct":100}', '{"yield_pct":85}',
   'Preparation yield set to 85% — trim, bone and fat. A 150 g portion now consumes ~176.5 g of stock.');
