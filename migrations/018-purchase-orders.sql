-- 018 — Automated Purchase Orders & Reorder Suggestions

CREATE TABLE IF NOT EXISTS purchase_orders (
  id           TEXT PRIMARY KEY,
  supplier_id  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft', -- 'draft' | 'approved' | 'received' | 'cancelled'
  total_cost   REAL DEFAULT 0,
  notes        TEXT,
  created_at   TEXT NOT NULL,
  created_by   TEXT,
  approved_at  TEXT,
  approved_by  TEXT,
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
);

CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id           TEXT PRIMARY KEY,
  po_id        TEXT NOT NULL,
  inventory_id TEXT NOT NULL,
  qty_ordered  REAL NOT NULL,
  unit_cost    REAL NOT NULL,
  line_total   REAL NOT NULL,
  FOREIGN KEY (po_id) REFERENCES purchase_orders(id),
  FOREIGN KEY (inventory_id) REFERENCES inventory(id)
);
