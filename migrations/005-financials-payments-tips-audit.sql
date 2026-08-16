-- 005 — order financials, real payment records, tips, delivery linkage, audit log.
--
-- Additive only. Every statement adds a column or creates a new table, so the
-- currently deployed Worker keeps working untouched while this is applied and
-- the API that uses these columns is deployed afterwards.
--
-- Apply with:
--   npx wrangler d1 execute fufut-db --remote --file=migrations/005-financials-payments-tips-audit.sql
--
-- NOTE: ALTER TABLE ADD COLUMN is not idempotent in SQLite. Re-running this file
-- fails on "duplicate column name", which means it already applied.

-- ─────────────────────────────────────────────────────────────────────────────
-- Orders: the money the POS has always collected but never stored
-- ─────────────────────────────────────────────────────────────────────────────
-- CheckoutView has a complete tip UI (percentage presets, fixed amount, live
-- badge) and a discount UI with a reason field. buildOrderPayload() sends
-- subtotal, tip, tipType, discount, discountType, discountReason and
-- paymentBreakdown on every order. The INSERT wrote ten columns and none of
-- them were these, and the table had nowhere to put them — so every tip and
-- every discount taken on the floor has been discarded at the Worker.
--
-- `total` keeps its meaning (what the guest pays) so no existing report moves.
-- These columns explain how that number was reached.
ALTER TABLE orders ADD COLUMN subtotal REAL;
ALTER TABLE orders ADD COLUMN discount REAL DEFAULT 0;
ALTER TABLE orders ADD COLUMN discount_type TEXT;
ALTER TABLE orders ADD COLUMN discount_reason TEXT;
ALTER TABLE orders ADD COLUMN tip REAL DEFAULT 0;
ALTER TABLE orders ADD COLUMN tip_type TEXT;
ALTER TABLE orders ADD COLUMN service_charge REAL DEFAULT 0;
ALTER TABLE orders ADD COLUMN tax REAL DEFAULT 0;
ALTER TABLE orders ADD COLUMN delivery_fee REAL DEFAULT 0;

-- Payment state is its own axis from kitchen state: a takeaway can be READY and
-- unpaid, a delivery can be DELIVERED and unpaid until the driver returns the
-- cash. Deriving either from the other is what makes those two flows impossible
-- to model.
ALTER TABLE orders ADD COLUMN payment_status TEXT DEFAULT 'unpaid';
ALTER TABLE orders ADD COLUMN paid_at TEXT;

-- Takeaway needs a way to reach the guest and a pickup state of its own; the
-- order status covers the kitchen, not the counter.
ALTER TABLE orders ADD COLUMN customer_phone TEXT;
ALTER TABLE orders ADD COLUMN pickup_status TEXT;
ALTER TABLE orders ADD COLUMN picked_up_at TEXT;

-- Who took the order. Recorded as both id and name: the id is the join, the
-- name is what stays answerable if that person later leaves and the row is
-- deactivated.
ALTER TABLE orders ADD COLUMN created_by TEXT;
ALTER TABLE orders ADD COLUMN created_by_name TEXT;

-- Void instead of DELETE. A cancelled order is a fact about the day's trading
-- and has to survive; removing the row destroys the sale, its lines, its
-- payments and its stock consumption in one statement with nothing recorded.
ALTER TABLE orders ADD COLUMN voided_at TEXT;
ALTER TABLE orders ADD COLUMN voided_by TEXT;
ALTER TABLE orders ADD COLUMN void_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_created     ON orders(created);
CREATE INDEX IF NOT EXISTS idx_orders_status      ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_paystatus   ON orders(payment_status);

-- ─────────────────────────────────────────────────────────────────────────────
-- payments — one row per tender, not a string
-- ─────────────────────────────────────────────────────────────────────────────
-- orders.payment is a single TEXT column, so a split bill was stored as
-- "cash+telebirr": the methods survived and the amounts did not. Per-method
-- revenue reporting cannot be produced from that, and neither can a reference
-- number, a transfer screenshot, or the cashier's verification.
--
-- orders.payment is deliberately left in place and still written, because
-- several screens and the receipt read it. It becomes a summary of this table
-- rather than the record itself.
--
-- amount is signed: a refund is a negative payment against the same order, so
-- the balance is always SUM(amount) and money is never removed by deleting a
-- row.
CREATE TABLE IF NOT EXISTS payments (
  id                TEXT PRIMARY KEY,
  order_id          TEXT NOT NULL,
  method            TEXT NOT NULL,          -- cash | telebirr | cbe | bank | card | other
  amount            REAL NOT NULL,          -- negative for a refund
  tendered          REAL,                   -- cash only
  change_due        REAL,                   -- cash only
  reference         TEXT,                   -- transaction / transfer reference
  evidence_key      TEXT,                   -- R2 key of the screenshot or photo
  status            TEXT NOT NULL DEFAULT 'recorded',  -- recorded | verified | rejected | refunded
  collected_by      TEXT,
  collected_by_name TEXT,
  verified_by       TEXT,
  verified_by_name  TEXT,
  verified_at       TEXT,
  notes             TEXT,
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payments_order  ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_method ON payments(method, created_at);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);

-- ─────────────────────────────────────────────────────────────────────────────
-- tips — money that belongs to staff, not to the restaurant
-- ─────────────────────────────────────────────────────────────────────────────
-- Kept out of `payments` on purpose. A tip is not revenue, and the fastest way
-- to overstate a day's sales is to let it sit in the same table as the takings
-- and rely on every future query remembering to exclude it.
--
-- orders.tip records what was added to that bill; this table records who is owed
-- it, which is the question the manager actually asks.
CREATE TABLE IF NOT EXISTS tips (
  id           TEXT PRIMARY KEY,
  order_id     TEXT,
  staff_id     TEXT,
  staff_name   TEXT,
  amount       REAL NOT NULL,
  method       TEXT,                        -- how the tip itself arrived
  evidence_key TEXT,
  status       TEXT NOT NULL DEFAULT 'recorded',  -- recorded | verified | paid_out
  source       TEXT,                        -- dine-in | takeaway | delivery
  date         TEXT NOT NULL,               -- YYYY-MM-DD, for daily/weekly/monthly rollups
  notes        TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tips_date  ON tips(date);
CREATE INDEX IF NOT EXISTS idx_tips_staff ON tips(staff_id, date);
CREATE INDEX IF NOT EXISTS idx_tips_order ON tips(order_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- delivery — complete the lifecycle
-- ─────────────────────────────────────────────────────────────────────────────
-- The table already carries orderId, customer, address, driver, status, eta,
-- phone and notes. Nothing ever wrote to it: an order with type='delivery' was
-- created and no delivery row followed, so delivery orders never reached the
-- Delivery screen at all.
--
-- These columns add the stages the real workflow has and the till did not:
-- assignment to a driver, the money coming back to the cashier, and the
-- timestamps that make "where is order 103" answerable.
ALTER TABLE delivery ADD COLUMN driver_id TEXT;
ALTER TABLE delivery ADD COLUMN fee REAL DEFAULT 0;
ALTER TABLE delivery ADD COLUMN assigned_at TEXT;
ALTER TABLE delivery ADD COLUMN picked_up_at TEXT;
ALTER TABLE delivery ADD COLUMN delivered_at TEXT;
ALTER TABLE delivery ADD COLUMN cancelled_at TEXT;
ALTER TABLE delivery ADD COLUMN updated_at TEXT;
-- Cash the driver is carrying is not yet the restaurant's cash. This tracks the
-- hand-back: collected on the doorstep, then settled with the cashier.
ALTER TABLE delivery ADD COLUMN payment_status TEXT DEFAULT 'unpaid';
ALTER TABLE delivery ADD COLUMN settled_at TEXT;
ALTER TABLE delivery ADD COLUMN settled_by TEXT;

CREATE INDEX IF NOT EXISTS idx_delivery_order  ON delivery(orderId);
CREATE INDEX IF NOT EXISTS idx_delivery_status ON delivery(status);
CREATE INDEX IF NOT EXISTS idx_delivery_driver ON delivery(driver_id, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- expenses — the fields a receipt actually has
-- ─────────────────────────────────────────────────────────────────────────────
-- Five columns (category, description, amount, date) cannot answer "who
-- approved this", "which supplier", "was it cash or transfer", or "show me the
-- receipt" — all of which the accountant asks for.
ALTER TABLE expenses ADD COLUMN supplier_id TEXT;
ALTER TABLE expenses ADD COLUMN payment_method TEXT;
ALTER TABLE expenses ADD COLUMN receipt_key TEXT;
ALTER TABLE expenses ADD COLUMN recorded_by TEXT;
ALTER TABLE expenses ADD COLUMN recorded_by_name TEXT;
ALTER TABLE expenses ADD COLUMN notes TEXT;
ALTER TABLE expenses ADD COLUMN voided_at TEXT;
ALTER TABLE expenses ADD COLUMN voided_by TEXT;
ALTER TABLE expenses ADD COLUMN void_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);

-- ─────────────────────────────────────────────────────────────────────────────
-- audit_log — who did what to which record
-- ─────────────────────────────────────────────────────────────────────────────
-- The backoffice has had an "Audit Log" nav item and there has never been a
-- table behind it. Price changes, discounts, refunds, stock adjustments and
-- permission changes all happened with nothing recorded.
--
-- before/after hold JSON of only the fields that changed, not whole rows: a full
-- snapshot of every write would outgrow the data it describes, and the question
-- being asked is always "what moved".
CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  at          TEXT NOT NULL,
  actor_id    TEXT,
  actor_name  TEXT,
  actor_role  TEXT,
  action      TEXT NOT NULL,   -- create | update | void | refund | adjust | verify | login…
  entity      TEXT NOT NULL,   -- orders | payments | inventory | menu | staff…
  entity_id   TEXT,
  before      TEXT,            -- JSON, changed fields only
  after       TEXT,            -- JSON, changed fields only
  reason      TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_at     ON audit_log(at);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor  ON audit_log(actor_id, at);
