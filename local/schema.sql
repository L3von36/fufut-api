-- Schema for a local FU FUT server, dumped from the production D1
-- database on 2026-08-18. Regenerate with:
--   npx wrangler d1 execute fufut-db --remote --command "SELECT sql FROM sqlite_master"
--
-- `_cf_KV` appears in that dump and is deliberately NOT here. It is D1's own
-- internal table: SQLite will happily create it, which is why this file worked
-- locally for weeks, but D1 refuses with SQLITE_AUTH — so a dump containing it
-- cannot bootstrap a D1 database at all. Found the first time this file was
-- applied to a real D1 instead of to local SQLite. The local KV shim uses its
-- own `_local_kv` table and never wanted this one.
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
CREATE TABLE IF NOT EXISTS cashdrawers (
    id TEXT PRIMARY KEY,
    shift_id TEXT,
    opened_at TEXT,
    opening_balance REAL,
    cash_sales REAL,
    closing_balance REAL,
    expected REAL,
    variance REAL,
    status TEXT,
    paid_in REAL DEFAULT 0,
    paid_out REAL DEFAULT 0,
    created TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_order INTEGER DEFAULT 0, name_am TEXT DEFAULT "");
CREATE TABLE IF NOT EXISTS content (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS "d1_migrations"(
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT UNIQUE,
                applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE IF NOT EXISTS delivery (
    id TEXT PRIMARY KEY,
    orderId TEXT,
    customer TEXT,
    address TEXT,
    driver TEXT,
    status TEXT DEFAULT 'pending',
    eta TEXT,
    phone TEXT,
    notes TEXT,
    created TIMESTAMP DEFAULT CURRENT_TIMESTAMP
, driver_id TEXT, fee REAL DEFAULT 0, assigned_at TEXT, picked_up_at TEXT, delivered_at TEXT, cancelled_at TEXT, updated_at TEXT, payment_status TEXT DEFAULT 'unpaid', settled_at TEXT, settled_by TEXT);
CREATE TABLE IF NOT EXISTS expenses (
    id TEXT PRIMARY KEY,
    category TEXT,
    description TEXT,
    amount REAL,
    date TEXT,
    created TIMESTAMP DEFAULT CURRENT_TIMESTAMP
, supplier_id TEXT, payment_method TEXT, receipt_key TEXT, recorded_by TEXT, recorded_by_name TEXT, notes TEXT, voided_at TEXT, voided_by TEXT, void_reason TEXT);
CREATE TABLE IF NOT EXISTS gallery (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    caption TEXT DEFAULT '',
    category TEXT DEFAULT 'general',
    created TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS inventory (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT,
    stock REAL DEFAULT 0,
    unit TEXT,
    min_level REAL DEFAULT 0,
    cost REAL DEFAULT 0,
    created TIMESTAMP DEFAULT CURRENT_TIMESTAMP
, yield_pct REAL DEFAULT 100, reorder_point REAL, target_stock REAL, preferred_supplier_id TEXT, pack_size REAL, pack_unit TEXT, avg_cost REAL, last_cost REAL, track_expiry INTEGER DEFAULT 0, shelf_life_days INTEGER, is_packaging INTEGER DEFAULT 0, active INTEGER DEFAULT 1, updated_at TEXT, stock_estimated INTEGER DEFAULT 0);
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
CREATE TABLE IF NOT EXISTS leave_requests (
  id          TEXT PRIMARY KEY,
  staff_id    TEXT NOT NULL,
  staff_name  TEXT,
  type        TEXT NOT NULL,      -- annual | sick | unpaid | maternity | bereavement | public-holiday
  start_date  TEXT NOT NULL,
  end_date    TEXT NOT NULL,
  days        REAL NOT NULL,
  paid        INTEGER DEFAULT 1,
  reason      TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | cancelled
  approved_by TEXT,
  approved_at TEXT,
  notes       TEXT,
  created_by  TEXT,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS menu (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT,
    price REAL,
    cost REAL,
    modifiers TEXT,
    image TEXT DEFAULT '',
    description TEXT DEFAULT '',
    available BOOLEAN DEFAULT 1,
    created TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS menu_items (id TEXT PRIMARY KEY, category_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT DEFAULT '', price REAL NOT NULL, cost REAL DEFAULT 0, modifiers TEXT DEFAULT '[]', available INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0, created TEXT DEFAULT (datetime('now')), image TEXT DEFAULT '', tags TEXT DEFAULT '', name_am TEXT DEFAULT "", description_am TEXT DEFAULT "");
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
, recipe_id TEXT, ingredient_cost REAL, packaging_cost REAL, recipe_variant TEXT, course TEXT DEFAULT 'main');
CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    items TEXT NOT NULL,
    total REAL,
    payment TEXT,
    type TEXT,
    table_id TEXT,
    customer TEXT,
    status TEXT DEFAULT 'new',
    created TIMESTAMP DEFAULT CURRENT_TIMESTAMP
, email TEXT DEFAULT '', notes TEXT, updated_at TEXT, preparing_at TEXT, ready_at TEXT, served_at TEXT, subtotal REAL, discount REAL DEFAULT 0, discount_type TEXT, discount_reason TEXT, tip REAL DEFAULT 0, tip_type TEXT, service_charge REAL DEFAULT 0, tax REAL DEFAULT 0, delivery_fee REAL DEFAULT 0, payment_status TEXT DEFAULT 'unpaid', paid_at TEXT, customer_phone TEXT, pickup_status TEXT, picked_up_at TEXT, created_by TEXT, created_by_name TEXT, voided_at TEXT, voided_by TEXT, void_reason TEXT, consumed_at TEXT, void_category TEXT);
CREATE TABLE IF NOT EXISTS overtime (
  id            TEXT PRIMARY KEY,
  staff_id      TEXT NOT NULL,
  staff_name    TEXT,
  date          TEXT NOT NULL,
  hours         REAL NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'normal',  -- normal | night | rest_day | public_holiday
  multiplier    REAL,        -- snapshot of the rate applied, so a settings change
                             -- does not rewrite what somebody was already paid
  hourly_rate   REAL,
  amount        REAL,
  reason        TEXT,
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | paid
  approved_by   TEXT,
  approved_at   TEXT,
  payroll_run_id TEXT,
  created_by    TEXT,
  created_at    TEXT NOT NULL
);
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
CREATE TABLE IF NOT EXISTS payroll_lines (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL,
  staff_id       TEXT NOT NULL,
  staff_name     TEXT,
  base_salary    REAL DEFAULT 0,
  overtime_pay   REAL DEFAULT 0,
  bonuses        REAL DEFAULT 0,
  deductions     REAL DEFAULT 0,
  gross_pay      REAL DEFAULT 0,
  taxable_pay    REAL DEFAULT 0,
  income_tax     REAL DEFAULT 0,
  pension_employee REAL DEFAULT 0,
  pension_employer REAL DEFAULT 0,
  net_pay        REAL DEFAULT 0,
  -- Tips are reported alongside pay because the person is owed them, but they
  -- are never added into gross: they are not the restaurant's money and taxing
  -- them as payroll would be wrong.
  tips_earned    REAL DEFAULT 0,
  days_worked    REAL DEFAULT 0,
  days_absent    REAL DEFAULT 0,
  breakdown      TEXT,   -- JSON snapshot of the rates used
  created_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payroll_runs (
  id           TEXT PRIMARY KEY,
  period_start TEXT NOT NULL,
  period_end   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft',  -- draft | finalised | paid
  gross_total  REAL DEFAULT 0,
  tax_total    REAL DEFAULT 0,
  pension_total REAL DEFAULT 0,
  net_total    REAL DEFAULT 0,
  provisional  INTEGER DEFAULT 1,   -- rates were unconfirmed when this was run
  notes        TEXT,
  created_by   TEXT,
  created_by_name TEXT,
  created_at   TEXT NOT NULL,
  finalised_at TEXT
);
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
, variant TEXT, provisional INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS reservations (
    id TEXT PRIMARY KEY,
    name TEXT,
    phone TEXT,
    email TEXT,
    date TEXT,
    time TEXT,
    guests INTEGER,
    table_id TEXT,
    status TEXT,
    notes TEXT,
    created TIMESTAMP DEFAULT CURRENT_TIMESTAMP
, start_at TEXT, end_at TEXT, duration_min INTEGER DEFAULT 90, released_at TEXT, released_by TEXT, no_show_at TEXT, updated_at TEXT, order_id TEXT, completed_at TEXT);
CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    author TEXT DEFAULT 'Anonymous',
    rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
    text TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    date TEXT,
    created TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    staff_id TEXT,
    role TEXT,
    expires_at TIMESTAMP,
    created TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,     -- JSON, so a tax band table fits as easily as a number
  category    TEXT,              -- payroll | tax | operations | service
  label       TEXT,
  description TEXT,
  updated_at  TEXT,
  updated_by  TEXT
);
CREATE TABLE IF NOT EXISTS shifts (
    id TEXT PRIMARY KEY,
    staff_id TEXT,
    date TEXT,
    start_time TEXT,
    end_time TEXT,
    role TEXT,
    created TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS staff (
    id TEXT PRIMARY KEY,
    firstName TEXT NOT NULL,
    lastName TEXT NOT NULL,
    email TEXT UNIQUE,
    phone TEXT,
    role TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    password_hash TEXT,
    created TIMESTAMP DEFAULT CURRENT_TIMESTAMP
, must_change_password INTEGER NOT NULL DEFAULT 0, password_set_at TEXT, hire_date TEXT, end_date TEXT, employment_type TEXT, base_salary REAL, salary_period TEXT DEFAULT 'monthly', bank_account TEXT, tin TEXT, pension_id TEXT, emergency_contact TEXT, emergency_phone TEXT, address TEXT, notes TEXT);
CREATE TABLE IF NOT EXISTS staff_adjustments (
  id          TEXT PRIMARY KEY,
  staff_id    TEXT NOT NULL,
  staff_name  TEXT,
  date        TEXT NOT NULL,
  type        TEXT NOT NULL,     -- bonus | deduction | advance | reimbursement | penalty
  amount      REAL NOT NULL,     -- signed
  taxable     INTEGER DEFAULT 1,
  reason      TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | paid | cancelled
  approved_by TEXT,
  approved_at TEXT,
  payroll_run_id TEXT,
  created_by  TEXT,
  created_at  TEXT NOT NULL
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
CREATE TABLE IF NOT EXISTS stock_counts (
  id            TEXT PRIMARY KEY,
  started_at    TEXT NOT NULL,
  completed_at  TEXT,
  status        TEXT NOT NULL DEFAULT 'open',   -- open | posted | abandoned
  counted_by    TEXT,
  counted_by_name TEXT,
  notes         TEXT
);
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
, batch_alloc TEXT);
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
CREATE TABLE IF NOT EXISTS tables (
    id TEXT PRIMARY KEY,
    number INTEGER,
    capacity INTEGER,
    section TEXT,
    status TEXT DEFAULT 'available',
    server_id TEXT,
    guest_count INTEGER DEFAULT 0,
    created TIMESTAMP DEFAULT CURRENT_TIMESTAMP
, name TEXT, shape TEXT, server TEXT, guests INTEGER DEFAULT 0, seated_at TEXT, notes TEXT);
CREATE TABLE IF NOT EXISTS timeclock (
    id TEXT PRIMARY KEY,
    staff_id TEXT,
    date TEXT,
    clock_in TEXT,
    clock_out TEXT,
    hours REAL,
    status TEXT,
    created TIMESTAMP DEFAULT CURRENT_TIMESTAMP
, scheduled_start TEXT, scheduled_end TEXT, late_minutes INTEGER DEFAULT 0, early_leave_minutes INTEGER DEFAULT 0, overtime_hours REAL DEFAULT 0, attendance_status TEXT, notes TEXT, approved_by TEXT);
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
CREATE TABLE IF NOT EXISTS waste (
    id TEXT PRIMARY KEY,
    item_id TEXT,
    qty REAL,
    unit TEXT,
    reason TEXT,
    est_cost REAL,
    logged_by TEXT,
    date TEXT,
    created TIMESTAMP DEFAULT CURRENT_TIMESTAMP
, inventory_id TEXT, posted_at TEXT, batch_id TEXT, notes TEXT, voided_at TEXT);
CREATE INDEX IF NOT EXISTS idx_adjustments_staff ON staff_adjustments(staff_id, date);
CREATE INDEX IF NOT EXISTS idx_audit_actor  ON audit_log(actor_id, at);
CREATE INDEX IF NOT EXISTS idx_audit_at     ON audit_log(at);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_batches_expiry ON inventory_batches(expiry_date)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_batches_item   ON inventory_batches(inventory_id, status);
CREATE INDEX IF NOT EXISTS idx_count_items_count ON stock_count_items(count_id);
CREATE INDEX IF NOT EXISTS idx_delivery_driver ON delivery(driver_id, status);
CREATE INDEX IF NOT EXISTS idx_delivery_order  ON delivery(orderId);
CREATE INDEX IF NOT EXISTS idx_delivery_status ON delivery(status);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);
CREATE INDEX IF NOT EXISTS idx_inventory_estimated
  ON inventory(stock_estimated) WHERE stock_estimated = 1;
CREATE INDEX IF NOT EXISTS idx_leave_staff  ON leave_requests(staff_id, start_date);
CREATE INDEX IF NOT EXISTS idx_leave_status ON leave_requests(status);
CREATE INDEX IF NOT EXISTS idx_leave_window ON leave_requests(start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_moves_batch ON stock_movements(inventory_id, at)
  WHERE batch_alloc IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_moves_item ON stock_movements(inventory_id, at);
CREATE INDEX IF NOT EXISTS idx_moves_ref  ON stock_movements(ref_type, ref_id);
CREATE INDEX IF NOT EXISTS idx_moves_type ON stock_movements(type, at);
CREATE INDEX IF NOT EXISTS idx_order_items_order  ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_status ON order_items(status, created_at);
CREATE INDEX IF NOT EXISTS idx_order_items_timing ON order_items(category, served_at);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created);
CREATE INDEX IF NOT EXISTS idx_orders_paystatus   ON orders(payment_status);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status, created);
CREATE INDEX IF NOT EXISTS idx_overtime_staff ON overtime(staff_id, date);
CREATE INDEX IF NOT EXISTS idx_overtime_status ON overtime(status);
CREATE INDEX IF NOT EXISTS idx_payments_method ON payments(method, created_at);
CREATE INDEX IF NOT EXISTS idx_payments_order  ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payroll_lines_run   ON payroll_lines(run_id);
CREATE INDEX IF NOT EXISTS idx_payroll_lines_staff ON payroll_lines(staff_id);
CREATE INDEX IF NOT EXISTS idx_purchase_items_inv      ON purchase_items(inventory_id);
CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase ON purchase_items(purchase_id);
CREATE INDEX IF NOT EXISTS idx_purchases_date     ON purchases(date);
CREATE INDEX IF NOT EXISTS idx_purchases_supplier ON purchases(supplier_id, date);
CREATE INDEX IF NOT EXISTS idx_recipe_items_inv    ON recipe_items(inventory_id);
CREATE INDEX IF NOT EXISTS idx_recipe_items_recipe ON recipe_items(recipe_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_recipes_active_variant
  ON recipes(menu_item_id, COALESCE(variant, ''))
  WHERE status = 'active' AND menu_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_recipes_item ON recipes(menu_item_id, status);
CREATE INDEX IF NOT EXISTS idx_recipes_item_variant ON recipes(menu_item_id, variant, status);
CREATE INDEX IF NOT EXISTS idx_recipes_provisional
  ON recipes(provisional, status) WHERE provisional = 1;
CREATE INDEX IF NOT EXISTS idx_reservations_date ON reservations(date);
CREATE INDEX IF NOT EXISTS idx_reservations_date_time ON reservations(date, time);
CREATE INDEX IF NOT EXISTS idx_reservations_status ON reservations(status);
CREATE INDEX IF NOT EXISTS idx_reservations_status_date ON reservations(status, date);
CREATE INDEX IF NOT EXISTS idx_reservations_window
  ON reservations(table_id, start_at, end_at)
  WHERE table_id IS NOT NULL AND table_id <> '';
CREATE INDEX IF NOT EXISTS idx_reservations_order
  ON reservations(order_id)
  WHERE order_id IS NOT NULL AND order_id <> '';
CREATE INDEX IF NOT EXISTS idx_reviews_created ON reviews(created);
CREATE INDEX IF NOT EXISTS idx_reviews_rating ON reviews(rating);
CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_suppliers_category ON suppliers(category);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tables_number ON tables(number);
CREATE INDEX IF NOT EXISTS idx_timeclock_staff_date ON timeclock(staff_id, date);
CREATE INDEX IF NOT EXISTS idx_tips_date  ON tips(date);
CREATE INDEX IF NOT EXISTS idx_tips_order ON tips(order_id);
CREATE INDEX IF NOT EXISTS idx_tips_staff ON tips(staff_id, date);
CREATE INDEX IF NOT EXISTS idx_waste_item ON waste(inventory_id, date);

-- Sync tables (migration 014). See migrations/014-sync.sql.
CREATE TABLE IF NOT EXISTS sync_outbox (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  entity    TEXT NOT NULL,   -- the table written to
  entity_id TEXT,            -- primary key of the affected row, when it can be told
  op        TEXT NOT NULL,   -- insert | update | delete
  payload   TEXT NOT NULL,   -- JSON { sql, params } — the write, verbatim
  at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_entity_seq ON sync_outbox(entity, entity_id, seq);
CREATE TABLE IF NOT EXISTS sync_identity (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  epoch      TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_cursors (
  site_id    TEXT NOT NULL,
  direction  TEXT NOT NULL,   -- in | out
  last_seq   INTEGER NOT NULL DEFAULT 0,
  epoch      TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (site_id, direction)
);
CREATE TABLE IF NOT EXISTS sync_reconciliation (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id       TEXT NOT NULL,   -- which peer the entry came from
  seq           INTEGER,         -- its seq on that peer, for tracing
  entity        TEXT NOT NULL,
  entity_id     TEXT,
  op            TEXT,
  payload       TEXT,
  reason        TEXT NOT NULL,   -- why it was not applied
  winner        TEXT,            -- local | cloud
  resolved      INTEGER NOT NULL DEFAULT 0,
  resolved_by   TEXT,
  resolved_at   TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reconciliation_open ON sync_reconciliation(resolved, created_at);
CREATE TABLE IF NOT EXISTS venue_heartbeat (
  site_id   TEXT PRIMARY KEY,
  last_seen TEXT NOT NULL,
  detail    TEXT
);

-- Table QR ordering (migration 015). See migrations/015-table-qr.sql.
-- ALTERs rather than columns in the CREATE above, so this file stays a
-- faithful dump of production plus the migrations applied on top of it.
ALTER TABLE tables ADD COLUMN qr_key TEXT;
ALTER TABLE orders ADD COLUMN source TEXT;
