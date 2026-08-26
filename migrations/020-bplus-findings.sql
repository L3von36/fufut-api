-- 020 — fixes for the 6 findings from the B+ simulation dress rehearsal.
--
-- Additive only. Every statement either adds a column or creates an index, so
-- the currently deployed Worker keeps working untouched while this is applied
-- and the API that uses these columns is deployed afterwards.
--
-- Apply with:
--   npx wrangler d1 execute fufut-db --remote --file=migrations/020-bplus-findings.sql
--
-- NOTE: ALTER TABLE ADD COLUMN is not idempotent in SQLite. Re-running this
-- file fails on "duplicate column name", which means it already applied.

-- ─────────────────────────────────────────────────────────────────────────────
-- Finding 5 — reservation ↔ order link
-- ─────────────────────────────────────────────────────────────────────────────
-- A reservation marked "seated" on a table did not carry the order_id of the
-- order that fulfilled it, so nightly "which reservations converted to revenue"
-- reporting had no join key. The waiter had to know which order belonged to
-- which reservation, and any mistake broke the link silently.
ALTER TABLE reservations ADD COLUMN order_id TEXT;
ALTER TABLE reservations ADD COLUMN completed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_reservations_order
  ON reservations(order_id)
  WHERE order_id IS NOT NULL AND order_id <> '';

-- ─────────────────────────────────────────────────────────────────────────────
-- Finding 6 — paid-in / paid-out reach the expected formula
-- ─────────────────────────────────────────────────────────────────────────────
-- Until now paid-in (adding change) and paid-out (buying supplies) were
-- recorded only as audit_log rows, so the drawer's `expected` was always
-- `opening + cash_sales` — any paid-in or paid-out surfaced as variance at
-- Z-count and the manager had to read the audit log to explain it. The columns
-- below let `expected` carry them directly.
ALTER TABLE cashdrawers ADD COLUMN paid_in REAL DEFAULT 0;
ALTER TABLE cashdrawers ADD COLUMN paid_out REAL DEFAULT 0;

-- ─────────────────────────────────────────────────────────────────────────────
-- Finding 3 — categorise voids (training vs customer vs kitchen)
-- ─────────────────────────────────────────────────────────────────────────────
-- The B+ simulation ran up a 33% void rate that was entirely operator error
-- (wrong endpoints, wrong payment method). The audit log treated every void
-- the same, so the manager reading the rate could not tell "we served 10
-- people and 0 walked away" from "we mis-fired 5 API calls". A category on the
-- void makes the rate honest: training, customer, kitchen, fraud, other.
ALTER TABLE orders ADD COLUMN void_category TEXT;
