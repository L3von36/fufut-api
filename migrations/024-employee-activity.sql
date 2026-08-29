-- 024 — employee activity module: breaks, tasks, handovers, notes.
--
-- Phase 2 of the Employee Daily History & Activity Tracking spec.
-- These tables sit alongside the existing timeclock, audit_log, and staff
-- tables; they do NOT duplicate any of that data. Activity logging is still
-- the audit_log's job — these tables hold only the new structured records
-- (breaks, tasks, handovers, notes) that the audit log cannot represent.
--
-- Apply with:
--   npx wrangler d1 execute fufut-db --remote --file=migrations/024-employee-activity.sql

-- ── break_records ──────────────────────────────────────────────────────
-- A break belongs to a timeclock entry (the shift it was taken during).
-- start_at / end_at are ISO timestamps (UTC, same as audit_log.at).
-- A break with end_at NULL is still in progress.
CREATE TABLE IF NOT EXISTS break_records (
  id           TEXT PRIMARY KEY,
  timeclock_id TEXT NOT NULL,
  staff_id     TEXT NOT NULL,
  start_at     TEXT NOT NULL,
  end_at       TEXT,
  duration_min REAL DEFAULT 0,
  notes        TEXT,
  created      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_breaks_staff ON break_records(staff_id, start_at);
CREATE INDEX IF NOT EXISTS idx_breaks_timeclock ON break_records(timeclock_id);

-- ── employee_tasks ────────────────────────────────────────────────────
-- Lightweight task system. Managers create tasks, employees mark them
-- complete. Tasks reference orders / tables / areas by name (not FK)
-- because the link is informational, not structural.
CREATE TABLE IF NOT EXISTS employee_tasks (
  id          TEXT PRIMARY KEY,
  staff_id    TEXT NOT NULL,            -- assigned employee
  created_by  TEXT,                      -- manager who created it
  title       TEXT NOT NULL,
  description TEXT,
  priority    TEXT DEFAULT 'normal',     -- low | normal | high | urgent
  due_at      TEXT,                      -- ISO timestamp or NULL (no deadline)
  area        TEXT,                      -- e.g. "Dining", "Restroom", "Kitchen"
  status      TEXT DEFAULT 'pending',    -- pending | in_progress | completed | failed | cancelled
  completed_at TEXT,
  note        TEXT,                      -- employee's completion note
  created     TEXT NOT NULL DEFAULT (datetime('now')),
  updated     TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_staff ON employee_tasks(staff_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON employee_tasks(status, due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON employee_tasks(created DESC);

-- ── shift_handovers ──────────────────────────────────────────────────
-- When an employee finishes a shift, they can record what's pending for
-- the next person. The next employee (or manager) can read it.
CREATE TABLE IF NOT EXISTS shift_handovers (
  id               TEXT PRIMARY KEY,
  staff_id         TEXT NOT NULL,          -- who is handing over
  timeclock_id     TEXT,                   -- the shift this handover belongs to
  pending_orders   TEXT,                   -- free text
  pending_tasks    TEXT,                   -- free text
  cash_info        TEXT,                   -- free text
  problems         TEXT,                   -- free text
  customer_issues  TEXT,                   -- free text
  inventory_notes  TEXT,                   -- free text
  important_notes  TEXT,                   -- free text
  created          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_handovers_staff ON shift_handovers(staff_id, created DESC);
CREATE INDEX IF NOT EXISTS idx_handovers_created ON shift_handovers(created DESC);

-- ── employee_notes ────────────────────────────────────────────────────
-- Manager notes on an employee (for reviews, incidents, etc.). Separate
-- from the audit trail because these are opinions/observations, not
-- system events.
CREATE TABLE IF NOT EXISTS employee_notes (
  id         TEXT PRIMARY KEY,
  staff_id   TEXT NOT NULL,
  created_by TEXT,                         -- manager who wrote it
  note       TEXT NOT NULL,
  category   TEXT DEFAULT 'general',      -- general | incident | review | warning
  created    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notes_staff ON employee_notes(staff_id, created DESC);
