-- 017 — Customer Profiles and Loyalty Points Program

CREATE TABLE IF NOT EXISTS customers (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  phone        TEXT UNIQUE,
  email        TEXT,
  points       INTEGER DEFAULT 0,
  total_spent  REAL DEFAULT 0,
  visits_count INTEGER DEFAULT 0,
  notes        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT
);

CREATE TABLE IF NOT EXISTS loyalty_transactions (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  order_id    TEXT,
  points      INTEGER NOT NULL, -- positive for earned, negative for redeemed
  type        TEXT NOT NULL,    -- 'earn' | 'redeem' | 'adjustment'
  description TEXT,
  created_at  TEXT NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);

-- Index for phone lookups
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
