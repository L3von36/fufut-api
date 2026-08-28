-- 022 — operations alerts (SLA rules).
--
-- The kitchen already calls a ticket critical at 15 minutes, a table nobody
-- cleared holds the floor plan for four hours, and a QR order can sit as `new`
-- for three weeks. Nothing in the system says "this is taking too long" — the
-- person who would act on it has to be looking at the right screen at the right
-- moment. This table is where the minute-by-minute sweep records what it found,
-- so a screen can show it and a manager can acknowledge it.
--
-- One row per (rule, entity) while the condition holds: the sweep raises the
-- first time a rule fires, updates the row if the severity changes, and marks
-- the row resolved when the condition clears (the food was served, the driver
-- was assigned). Acknowledged rows are never re-raised — an ack is a person
-- saying "I have this", and a system that re-asks every minute trains people
-- to ignore it.
--
-- Additive only. Apply with:
--   npx wrangler d1 execute fufut-db --remote --file=migrations/022-alerts.sql

CREATE TABLE IF NOT EXISTS alerts (
    id            TEXT PRIMARY KEY,
    rule_id       TEXT NOT NULL,
    severity      TEXT NOT NULL DEFAULT 'warning',
    entity_type   TEXT NOT NULL,
    entity_id     TEXT NOT NULL,
    entity_label  TEXT,
    message       TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'open',
    created       TEXT NOT NULL,
    acknowledged_at  TEXT,
    acknowledged_by  TEXT,
    resolved_at      TEXT,
    updated_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status, created);
CREATE INDEX IF NOT EXISTS idx_alerts_entity ON alerts(entity_type, entity_id);
-- The sweep's dedupe lookup: one read to find every live row for a rule/entity
-- pair before deciding to raise.
CREATE INDEX IF NOT EXISTS idx_alerts_rule_entity ON alerts(rule_id, entity_id, status);
