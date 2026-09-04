-- Migration 026 — station-aware alerts + the bill request flow.
--
-- alerts.station
--   Which station owns the work behind an order-stage alert: 'bar' (every
--   line is a drink), 'kitchen' (none is), 'mixed' (both stations hold
--   unfinished lines) or '' (unclassifiable legacy rows — these fall back to
--   the kitchen audience, the one they had before the split). This is what
--   routes a slow tea ticket to the barista instead of the chef.
--
-- alerts.target_staff_id
--   The person an alert is FOR, not just about — the pickup ping ("order
--   ready") aims at the waiter assigned to the table, else the order's
--   creator. Empty = broadcast to the rule's targeted roles.
--
-- tables.bill_requested_at / bill_requested_by
--   The waiter's "table X asks for the bill": stamped by
--   POST /api/tables/:id/request-bill, cleared by settling (payments.js),
--   retraction, or any status change that ends the party.
--
-- All four are additive ALTERs; the statements are idempotent in the same
-- style as migration 020 (a repeat call reports "duplicate column name" as
-- skipped). Applied to production via POST /api/migrate/alerts-026.

ALTER TABLE alerts ADD COLUMN station TEXT DEFAULT '';
ALTER TABLE alerts ADD COLUMN target_staff_id TEXT DEFAULT '';
ALTER TABLE tables ADD COLUMN bill_requested_at TEXT DEFAULT '';
ALTER TABLE tables ADD COLUMN bill_requested_by TEXT DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_alerts_status_rule ON alerts(status, rule_id);
