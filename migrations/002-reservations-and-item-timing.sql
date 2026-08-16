-- 002 — reservation exclusivity, per-item order timing, and tables 6-10.
--
-- Additive only. Every statement either adds a column, creates a new table, or
-- inserts with OR IGNORE, so the currently deployed worker keeps working
-- untouched while this is applied and the API that uses these columns is
-- deployed afterwards.
--
-- Apply with:
--   npx wrangler d1 execute fufut-db --remote --file=migrations/002-reservations-and-item-timing.sql
--
-- NOTE: ALTER TABLE ADD COLUMN is not idempotent in SQLite. Re-running this
-- file fails on "duplicate column name", which means it already applied.

-- ─────────────────────────────────────────────────────────────────────────────
-- Reservations: a real time window instead of free text
-- ─────────────────────────────────────────────────────────────────────────────
-- date/time are kept as-is for display and back-compatibility, but they cannot
-- be compared: production holds both "18:30" and "7:00 AM" in the same column.
-- start_at/end_at are ISO-8601 UTC and are what exclusivity is computed from.
ALTER TABLE reservations ADD COLUMN start_at TEXT;
ALTER TABLE reservations ADD COLUMN end_at TEXT;
ALTER TABLE reservations ADD COLUMN duration_min INTEGER DEFAULT 90;

-- Audit for the two ways a held table is given up. Both are deliberate acts and
-- both need to be answerable later: who freed this table, and when.
ALTER TABLE reservations ADD COLUMN released_at TEXT;
ALTER TABLE reservations ADD COLUMN released_by TEXT;
ALTER TABLE reservations ADD COLUMN no_show_at TEXT;
ALTER TABLE reservations ADD COLUMN updated_at TEXT;

-- Overlap lookups always filter table_id and compare the window, so the index
-- is ordered to match. Partial on table_id so the 15 legacy rows with no table
-- do not bloat it.
CREATE INDEX IF NOT EXISTS idx_reservations_window
  ON reservations(table_id, start_at, end_at)
  WHERE table_id IS NOT NULL AND table_id <> '';

-- ─────────────────────────────────────────────────────────────────────────────
-- Orders: lifecycle timestamps
-- ─────────────────────────────────────────────────────────────────────────────
-- KitchenView already renders "ready for N min" from o.updated, a column that
-- has never existed, so that figure has always been NaN. updated_at fixes it.
ALTER TABLE orders ADD COLUMN updated_at TEXT;
ALTER TABLE orders ADD COLUMN preparing_at TEXT;
ALTER TABLE orders ADD COLUMN ready_at TEXT;
ALTER TABLE orders ADD COLUMN served_at TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- order_items: per-line tracking
-- ─────────────────────────────────────────────────────────────────────────────
-- orders.items stays as the JSON snapshot of what was ordered, because it is
-- what the receipt and every existing screen read. This table is the tracking
-- surface: one row per line, each with its own status and timestamps, which is
-- the only way "the coffee took 10 minutes and the food took 20" can be a
-- measurement rather than an estimate.
--
-- category is captured at order time, not looked up later, because a dish can
-- be recategorised or deleted from the menu and the timing history must still
-- describe what was actually sold that day.
CREATE TABLE IF NOT EXISTS order_items (
  id            TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL,
  line_no       INTEGER NOT NULL DEFAULT 0,
  menu_item_id  TEXT,
  name          TEXT NOT NULL,
  category      TEXT,
  qty           INTEGER NOT NULL DEFAULT 1,
  unit_price    REAL NOT NULL DEFAULT 0,
  modifiers     TEXT,
  notes         TEXT,
  status        TEXT NOT NULL DEFAULT 'new',
  created_at    TEXT,
  preparing_at  TEXT,
  ready_at      TEXT,
  served_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_order_items_order  ON order_items(order_id);
-- The kitchen board reads "everything not yet served", so status leads.
CREATE INDEX IF NOT EXISTS idx_order_items_status ON order_items(status, created_at);
-- Timing reports group by category over a date range.
CREATE INDEX IF NOT EXISTS idx_order_items_timing ON order_items(category, served_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- Tables 6-10
-- ─────────────────────────────────────────────────────────────────────────────
-- OR IGNORE keys off the primary key, so re-running never duplicates a table.
-- Capacity and section are placeholders: set to the most common shape in the
-- existing five so the floor plan is usable immediately, and editable per table
-- from the manager's Add/Edit Table screen once the real layout is known.
INSERT OR IGNORE INTO tables
  (id, number, capacity, section, status, shape, name, guests, guest_count, server, seated_at, notes)
VALUES
  ('T6',  6, 4, 'Main Hall', 'available', 'square', 'Table 6',  0, 0, '', '', ''),
  ('T7',  7, 4, 'Main Hall', 'available', 'square', 'Table 7',  0, 0, '', '', ''),
  ('T8',  8, 2, 'Window',    'available', 'round',  'Table 8',  0, 0, '', '', ''),
  ('T9',  9, 6, 'Patio',     'available', 'long',   'Table 9',  0, 0, '', '', ''),
  ('T10', 10, 4, 'Patio',    'available', 'square', 'Table 10', 0, 0, '', '', '');

-- A table number must identify exactly one table: orders and reservations both
-- resolve tables by number, so a duplicate makes that lookup ambiguous. The
-- existing rows are already unique, so this is safe to add now and it stops the
-- Add Table screen, which has no duplicate check, from ever creating one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tables_number ON tables(number);
