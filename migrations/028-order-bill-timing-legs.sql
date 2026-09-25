-- Migration 028 — the bill-timing legs ride the ORDER, not the table.
--
-- orders.bill_requested_at / orders.bill_method
--   The waiter's "bring the bill" was stamped on the TABLE row only, so the
--   moment the party ended the stamp was wiped and the Order Log showed
--   "Bill asked for — pending" forever on every settled check from that
--   table (owner's report, 2026-09-25). The stamp now ALSO lands on the
--   table's open checks the moment the request is raised, together with the
--   guest's intended payment method (cash / telebirr / cbe / bank / card /
--   other) and an optional note — the answer to "how does the cashier know
--   whether the guest will pay cash or transfer, and where should the money
--   go?" before the cashier has walked over.
--
-- orders.cleared_at
--   "Table cleared" was journal-only (per-device), so only the device that
--   freed the table could show the leg. Freeing a table now stamps
--   cleared_at on its open checks, cross-device.
--
-- tables.bill_method
--   The floor plan's pulsing "Bill Requested" chip reads the method straight
--   off the table row, so the runner who fetches the cashier already knows
--   what the guest plans to pay with.
--
-- settings.payments.channels
--   Seed of the venue's receiving accounts (telebirr number, CBE account,
--   bank details). The bill-request sheet shows them so the waiter can tell
--   the guest exactly where to send the money. Values are placeholders —
--   the manager edits them via PUT /api/settings/payments.channels.
--
-- All statements are additive; idempotent in the same style as migration
-- 026 (a repeat call reports "duplicate column name" as skipped). Applied
-- to production via POST /api/migrate/order-legs-028.

ALTER TABLE orders ADD COLUMN bill_requested_at TEXT;
ALTER TABLE orders ADD COLUMN bill_method TEXT;
ALTER TABLE orders ADD COLUMN cleared_at TEXT;
ALTER TABLE tables ADD COLUMN bill_method TEXT DEFAULT '';

INSERT OR IGNORE INTO settings (key, value, category, label, description, updated_at) VALUES
  ('payments.channels',
   '[{"method":"telebirr","label":"Telebirr","account":"","holder":""},{"method":"cbe","label":"CBE Birr","account":"","holder":""},{"method":"bank","label":"Bank transfer","account":"","holder":""},{"method":"card","label":"Card","account":"","holder":""}]',
   'operations',
   'Receiving accounts for digital payments',
   'Shown to the floor when a guest asks where to send the money. Fill the account/holder for each channel the venue accepts; leave account empty to hide the channel.',
   datetime('now'));
