-- Migration 021 — stamp when a drawer session was closed
--
-- The Z-Report History listed each session's OPENED time under a "Closed
-- Time" header, because `created` (the drawer's open timestamp) was the only
-- time the table ever recorded. `closed_at` now holds the Z-count moment so
-- the column, the thermal Z-report and the audit trail all agree. Existing
-- closed rows stay NULL and the client falls back to `created` for them.

ALTER TABLE cashdrawers ADD COLUMN closed_at TEXT;
