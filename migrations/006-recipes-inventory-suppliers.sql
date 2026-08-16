-- 006 — the recipe/BOM engine, the stock ledger, suppliers and purchases.
--
-- This is the migration behind the spec's central requirement: inventory must
-- not be `Product → Quantity`. Until now it was exactly that — a flat table
-- edited by overwrite, with no link to what was sold. Selling a coffee did not
-- consume coffee, so none of the questions in §61 could be answered.
--
-- Additive only. Existing tables gain columns; nothing is dropped or rewritten,
-- and the `inventory` table keeps `stock` as its current-quantity column so
-- every screen that reads it today carries on working. What changes is that
-- `stock` becomes a figure derived from movements rather than typed in.
--
-- Apply with:
--   npx wrangler d1 execute fufut-db --remote --file=migrations/006-recipes-inventory-suppliers.sql
--
-- NOTE: ALTER TABLE ADD COLUMN is not idempotent in SQLite. Re-running this file
-- fails on "duplicate column name", which means it already applied.

-- ─────────────────────────────────────────────────────────────────────────────
-- inventory — the properties a raw material needs
-- ─────────────────────────────────────────────────────────────────────────────
-- `unit` already exists and stays the stocking unit. Recipes may be written in
-- any compatible unit and are converted at the point of use (see lib/units.js).

-- Preparation yield. 100 kg of raw meat does not become 100 kg of servable
-- meat; the spec asks for ~85%. Configurable per item and never hard-coded,
-- because the figure is a property of the ingredient and the kitchen, not of
-- the software.
ALTER TABLE inventory ADD COLUMN yield_pct REAL DEFAULT 100;

-- Reorder management. `min_level` exists and drives the current low-stock
-- banner; these add the rest of what a reorder list needs to recommend a
-- quantity rather than just raise an alarm.
ALTER TABLE inventory ADD COLUMN reorder_point REAL;
ALTER TABLE inventory ADD COLUMN target_stock REAL;
ALTER TABLE inventory ADD COLUMN preferred_supplier_id TEXT;

-- Buying by the box while stocking by the piece. A box is not a fixed quantity
-- anywhere in the world, so the size lives on the item rather than in the unit
-- table.
ALTER TABLE inventory ADD COLUMN pack_size REAL;
ALTER TABLE inventory ADD COLUMN pack_unit TEXT;

-- Weighted average cost, recalculated on each purchase. `cost` already exists
-- and is whatever was last typed in; this is derived from what was actually
-- paid, and is what ingredient costing uses.
ALTER TABLE inventory ADD COLUMN avg_cost REAL;
ALTER TABLE inventory ADD COLUMN last_cost REAL;

-- Perishables. Only items flagged here get batch/expiry handling, so the
-- kitchen is not asked for an expiry date on napkins.
ALTER TABLE inventory ADD COLUMN track_expiry INTEGER DEFAULT 0;
ALTER TABLE inventory ADD COLUMN shelf_life_days INTEGER;

ALTER TABLE inventory ADD COLUMN is_packaging INTEGER DEFAULT 0;
ALTER TABLE inventory ADD COLUMN active INTEGER DEFAULT 1;
ALTER TABLE inventory ADD COLUMN updated_at TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- recipes — versioned, because history must not move
-- ─────────────────────────────────────────────────────────────────────────────
-- A recipe is a version. Changing a coffee from 18 g to 20 g creates a new row
-- and archives the old one; it never edits in place. Orders record the recipe
-- id they consumed against, so last month's sales keep saying 18 g and last
-- month's food cost stays what it was — §25.
--
-- yield_qty is how many servings one execution of the recipe produces. It is 1
-- for a coffee and 100 for a pot of wot cooked in the morning, which is what
-- makes batch production (§34) the same mechanism rather than a second one.
CREATE TABLE IF NOT EXISTS recipes (
  id            TEXT PRIMARY KEY,
  menu_item_id  TEXT,
  name          TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'active',   -- active | archived | draft
  yield_qty     REAL NOT NULL DEFAULT 1,
  yield_unit    TEXT DEFAULT 'serving',
  notes         TEXT,
  effective_from TEXT,
  archived_at   TEXT,
  created_by    TEXT,
  created_by_name TEXT,
  created_at    TEXT NOT NULL
);

-- One active recipe per menu item. Two would make "which one did we consume"
-- ambiguous at the exact moment the answer has to be recorded.
CREATE UNIQUE INDEX IF NOT EXISTS idx_recipes_active_item
  ON recipes(menu_item_id) WHERE status = 'active' AND menu_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_recipes_item ON recipes(menu_item_id, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- recipe_items — the BOM lines
-- ─────────────────────────────────────────────────────────────────────────────
-- `unit` here is the unit the chef writes the recipe in (18 g), which need not
-- be the unit the item is stocked in (kg). Conversion happens at consumption.
--
-- is_packaging marks cups, lids, napkins and bags. They are ordinary BOM lines
-- — the same engine, the same ledger — but flagged so menu costing can show
-- packaging cost separately as §30 asks, and so a dine-in coffee can skip them.
CREATE TABLE IF NOT EXISTS recipe_items (
  id            TEXT PRIMARY KEY,
  recipe_id     TEXT NOT NULL,
  inventory_id  TEXT NOT NULL,
  qty           REAL NOT NULL,
  unit          TEXT NOT NULL,
  is_packaging  INTEGER DEFAULT 0,
  -- Loss inherent to preparing this line specifically: grounds left in the
  -- portafilter, milk left in the jug. Separate from the item's own prep yield.
  waste_pct     REAL DEFAULT 0,
  optional      INTEGER DEFAULT 0,
  sort_order    INTEGER DEFAULT 0,
  notes         TEXT
);

CREATE INDEX IF NOT EXISTS idx_recipe_items_recipe ON recipe_items(recipe_id);
-- "Which dishes use milk" — the shared-ingredient question in §24.
CREATE INDEX IF NOT EXISTS idx_recipe_items_inv    ON recipe_items(inventory_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- stock_movements — the ledger
-- ─────────────────────────────────────────────────────────────────────────────
-- Every change to stock is a row here, and `inventory.stock` becomes the
-- running total rather than a number somebody typed. The behaviour this
-- replaces: the only write path was a PUT that set the new value, so the
-- previous quantity was destroyed and nothing recorded who changed it or why.
--
-- qty is signed and expressed in the item's stocking unit: purchases and
-- positive adjustments are positive, sales/waste/negative adjustments are
-- negative. Current stock is always SUM(qty), which means stock can be rebuilt
-- from the ledger if it is ever doubted.
--
-- balance_after is stored as well as derivable, so a statement can be read back
-- as it stood at the time without replaying the whole table.
CREATE TABLE IF NOT EXISTS stock_movements (
  id            TEXT PRIMARY KEY,
  at            TEXT NOT NULL,
  inventory_id  TEXT NOT NULL,
  qty           REAL NOT NULL,          -- signed, in the item's stocking unit
  unit          TEXT,
  type          TEXT NOT NULL,          -- purchase | sale | waste | adjustment |
                                        -- production | count | void_reversal | transfer
  ref_type      TEXT,                   -- orders | purchases | waste | stock_counts…
  ref_id        TEXT,
  unit_cost     REAL,
  total_cost    REAL,
  balance_after REAL,
  actor_id      TEXT,
  actor_name    TEXT,
  reason        TEXT,
  notes         TEXT
);

CREATE INDEX IF NOT EXISTS idx_moves_item ON stock_movements(inventory_id, at);
CREATE INDEX IF NOT EXISTS idx_moves_type ON stock_movements(type, at);
CREATE INDEX IF NOT EXISTS idx_moves_ref  ON stock_movements(ref_type, ref_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Consumption bookkeeping on the sale
-- ─────────────────────────────────────────────────────────────────────────────
-- consumed_at makes posting idempotent: an order whose stock has already been
-- taken cannot be posted twice, which is the "double inventory deduction"
-- failure in §56. Without it, any retry or double-tap silently halves the stock.
ALTER TABLE orders ADD COLUMN consumed_at TEXT;

-- The recipe version actually consumed, and what it cost at that moment. This
-- is the snapshot that stops a recipe change rewriting history (§25): margin
-- reports for last month read these columns, not today's recipe.
ALTER TABLE order_items ADD COLUMN recipe_id TEXT;
ALTER TABLE order_items ADD COLUMN ingredient_cost REAL;
ALTER TABLE order_items ADD COLUMN packaging_cost REAL;

-- ─────────────────────────────────────────────────────────────────────────────
-- suppliers
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS suppliers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  category    TEXT,                     -- meat | milk | coffee | gas | maintenance…
  contact     TEXT,
  phone       TEXT,
  email       TEXT,
  address     TEXT,
  -- What they supply, free text, so a vendor who sells both charcoal and gas is
  -- one supplier rather than two.
  supplies    TEXT,
  notes       TEXT,
  status      TEXT DEFAULT 'active',
  created     TEXT NOT NULL,
  updated_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_suppliers_category ON suppliers(category);

-- ─────────────────────────────────────────────────────────────────────────────
-- purchases — money out, stock in, supplier balance up
-- ─────────────────────────────────────────────────────────────────────────────
-- `paid` is separate from `total` because Fufut buys on account: a vendor
-- delivers today and is settled on Friday. Outstanding balance per supplier is
-- SUM(total - paid), which is the "which suppliers do we owe" question in §61.
CREATE TABLE IF NOT EXISTS purchases (
  id              TEXT PRIMARY KEY,
  supplier_id     TEXT,
  supplier_name   TEXT,
  date            TEXT NOT NULL,
  total           REAL NOT NULL DEFAULT 0,
  paid            REAL NOT NULL DEFAULT 0,
  payment_method  TEXT,
  status          TEXT DEFAULT 'received',  -- ordered | received | cancelled
  receipt_key     TEXT,
  notes           TEXT,
  -- Set when the lines have been posted to the ledger, so a purchase cannot
  -- add its stock twice.
  posted_at       TEXT,
  voided_at       TEXT,
  voided_by       TEXT,
  void_reason     TEXT,
  created_by      TEXT,
  created_by_name TEXT,
  created         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_purchases_supplier ON purchases(supplier_id, date);
CREATE INDEX IF NOT EXISTS idx_purchases_date     ON purchases(date);

CREATE TABLE IF NOT EXISTS purchase_items (
  id            TEXT PRIMARY KEY,
  purchase_id   TEXT NOT NULL,
  inventory_id  TEXT NOT NULL,
  qty           REAL NOT NULL,
  unit          TEXT NOT NULL,
  unit_cost     REAL NOT NULL DEFAULT 0,
  total_cost    REAL NOT NULL DEFAULT 0,
  batch_no      TEXT,
  expiry_date   TEXT
);

CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase ON purchase_items(purchase_id);
CREATE INDEX IF NOT EXISTS idx_purchase_items_inv      ON purchase_items(inventory_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- inventory_batches — expiry and FEFO
-- ─────────────────────────────────────────────────────────────────────────────
-- Only created for items with track_expiry = 1. qty_remaining lets the
-- "expiring soon" list show how much is actually at risk rather than just
-- naming the item.
CREATE TABLE IF NOT EXISTS inventory_batches (
  id                TEXT PRIMARY KEY,
  inventory_id      TEXT NOT NULL,
  purchase_item_id  TEXT,
  supplier_id       TEXT,
  batch_no          TEXT,
  received_at       TEXT NOT NULL,
  expiry_date       TEXT,
  qty_received      REAL NOT NULL,
  qty_remaining     REAL NOT NULL,
  unit              TEXT,
  unit_cost         REAL,
  status            TEXT DEFAULT 'open'   -- open | depleted | expired | discarded
);

CREATE INDEX IF NOT EXISTS idx_batches_item   ON inventory_batches(inventory_id, status);
-- FEFO: first to expire is first out.
CREATE INDEX IF NOT EXISTS idx_batches_expiry ON inventory_batches(expiry_date)
  WHERE status = 'open';

-- ─────────────────────────────────────────────────────────────────────────────
-- stock counts — a count is an adjustment, never an overwrite
-- ─────────────────────────────────────────────────────────────────────────────
-- §27: recording a physical count must produce an adjustment with a reason, so
-- the difference between what the system believed and what was on the shelf is
-- itself a fact. Overwriting the number destroys precisely the information the
-- count was performed to obtain.
CREATE TABLE IF NOT EXISTS stock_counts (
  id            TEXT PRIMARY KEY,
  started_at    TEXT NOT NULL,
  completed_at  TEXT,
  status        TEXT NOT NULL DEFAULT 'open',   -- open | posted | abandoned
  counted_by    TEXT,
  counted_by_name TEXT,
  notes         TEXT
);

CREATE TABLE IF NOT EXISTS stock_count_items (
  id            TEXT PRIMARY KEY,
  count_id      TEXT NOT NULL,
  inventory_id  TEXT NOT NULL,
  system_qty    REAL,          -- what the ledger said when the count was taken
  counted_qty   REAL,          -- what was physically on the shelf
  variance      REAL,          -- counted - system
  unit          TEXT,
  reason        TEXT,          -- spillage | breakage | miscount | theft | unknown…
  notes         TEXT
);

CREATE INDEX IF NOT EXISTS idx_count_items_count ON stock_count_items(count_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- waste — connect it to the ledger
-- ─────────────────────────────────────────────────────────────────────────────
-- The waste screen already logs what was thrown away and has never reduced
-- stock, so wasted food stayed on the books as though it were still there.
-- posted_at marks that the movement has been written, keeping it idempotent.
ALTER TABLE waste ADD COLUMN inventory_id TEXT;
ALTER TABLE waste ADD COLUMN posted_at TEXT;
ALTER TABLE waste ADD COLUMN batch_id TEXT;
ALTER TABLE waste ADD COLUMN notes TEXT;
ALTER TABLE waste ADD COLUMN voided_at TEXT;

CREATE INDEX IF NOT EXISTS idx_waste_item ON waste(inventory_id, date);
