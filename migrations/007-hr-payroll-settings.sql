-- 007 — employees, attendance, overtime, leave, staff financial records, settings.
--
-- Covers §46 and §51 of the spec. The system could already say who was on shift
-- and when they clocked in; it could not say whether they were late, whether
-- they were owed overtime, whether they were on approved leave, or what the
-- accountant needs at the end of the month.
--
-- ── Nothing legal or fiscal is hard-coded ───────────────────────────────────
-- §46 is explicit: do not hard-code tax or legal rules. Ethiopian income tax
-- bands, pension rates and overtime multipliers all live in `settings` as data,
-- so they are corrected by editing a row rather than by shipping a release.
-- lib/payroll.js reads them and computes nothing it was not given.
--
-- Additive only. Apply with:
--   npx wrangler d1 execute fufut-db --remote --file=migrations/007-hr-payroll-settings.sql
--
-- NOTE: ALTER TABLE ADD COLUMN is not idempotent in SQLite. Re-running fails on
-- "duplicate column name", which means it already applied.

-- ─────────────────────────────────────────────────────────────────────────────
-- settings — configurable business rules
-- ─────────────────────────────────────────────────────────────────────────────
-- Deliberately a key/value table rather than columns. These are policy, they
-- change without warning, and a migration per rate change is how a system ends
-- up with the wrong rate in it for six months.
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,     -- JSON, so a tax band table fits as easily as a number
  category    TEXT,              -- payroll | tax | operations | service
  label       TEXT,
  description TEXT,
  updated_at  TEXT,
  updated_by  TEXT
);

-- Seeded with the shape the calculations expect, not with advice. Every figure
-- here is a placeholder for the business to confirm with its accountant —
-- `_unverified` says so in the data itself, and the payroll API refuses to
-- present a payslip as final while it is set.
INSERT OR IGNORE INTO settings (key, value, category, label, description, updated_at) VALUES
  ('payroll._unverified', 'true', 'payroll', 'Rates not yet confirmed',
   'Set to false once an accountant has confirmed the bands and rates below. Payroll output is marked provisional until then.',
   datetime('now')),

  -- Overtime multipliers. Ethiopian labour law distinguishes ordinary overtime,
  -- night work, weekly rest days and public holidays; the multipliers are left
  -- for the business to confirm.
  ('payroll.overtime_multipliers',
   '{"normal":1.5,"night":1.75,"rest_day":2.0,"public_holiday":2.5}',
   'payroll', 'Overtime multipliers',
   'Applied to the hourly rate derived from monthly salary and contracted hours.',
   datetime('now')),

  ('payroll.monthly_hours', '208', 'payroll', 'Contracted hours per month',
   'Used to derive an hourly rate from a monthly salary.', datetime('now')),

  -- Progressive bands, evaluated in order. Stored as data so a budget change is
  -- a settings edit.
  ('tax.income_bands',
   '[{"upTo":600,"rate":0,"deduct":0},{"upTo":1650,"rate":0.10,"deduct":60},{"upTo":3200,"rate":0.15,"deduct":142.5},{"upTo":5250,"rate":0.20,"deduct":302.5},{"upTo":7800,"rate":0.25,"deduct":565},{"upTo":10900,"rate":0.30,"deduct":955},{"upTo":null,"rate":0.35,"deduct":1500}]',
   'tax', 'Income tax bands',
   'Progressive bands applied to taxable pay. upTo null is the top band.',
   datetime('now')),

  ('payroll.pension', '{"employee":0.07,"employer":0.11}', 'payroll', 'Pension contribution',
   'Employee and employer shares of basic salary.', datetime('now')),

  ('attendance.late_grace_minutes', '10', 'operations', 'Late grace period',
   'Minutes after the scheduled start before an arrival counts as late.', datetime('now')),

  ('attendance.standard_day_hours', '8', 'operations', 'Standard working day',
   'Hours beyond which time worked counts toward overtime.', datetime('now')),

  ('service.charge_pct', '0', 'service', 'Service charge',
   'Percentage added to a bill. Zero means none is applied.', datetime('now')),

  ('service.vat_pct', '0', 'service', 'VAT',
   'Percentage applied to a bill. Zero means none is applied.', datetime('now'));

-- ─────────────────────────────────────────────────────────────────────────────
-- staff — the employment record behind the login
-- ─────────────────────────────────────────────────────────────────────────────
-- `staff` was an account: name, email, role, password. These are the fields
-- that make it an employee record the accountant can work from.
ALTER TABLE staff ADD COLUMN hire_date TEXT;
ALTER TABLE staff ADD COLUMN end_date TEXT;
ALTER TABLE staff ADD COLUMN employment_type TEXT;   -- full-time | part-time | casual
ALTER TABLE staff ADD COLUMN base_salary REAL;
ALTER TABLE staff ADD COLUMN salary_period TEXT DEFAULT 'monthly';
ALTER TABLE staff ADD COLUMN bank_account TEXT;
ALTER TABLE staff ADD COLUMN tin TEXT;               -- taxpayer identification
ALTER TABLE staff ADD COLUMN pension_id TEXT;
ALTER TABLE staff ADD COLUMN emergency_contact TEXT;
ALTER TABLE staff ADD COLUMN emergency_phone TEXT;
ALTER TABLE staff ADD COLUMN address TEXT;
ALTER TABLE staff ADD COLUMN notes TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- timeclock — classify the day, do not just stamp it
-- ─────────────────────────────────────────────────────────────────────────────
-- The table recorded clock_in, clock_out and hours. It could not answer "was
-- this person late", which is the question attendance exists to answer. The
-- classification is stored rather than derived on read, because the schedule it
-- was judged against can change afterwards and the judgement must not.
ALTER TABLE timeclock ADD COLUMN scheduled_start TEXT;
ALTER TABLE timeclock ADD COLUMN scheduled_end TEXT;
ALTER TABLE timeclock ADD COLUMN late_minutes INTEGER DEFAULT 0;
ALTER TABLE timeclock ADD COLUMN early_leave_minutes INTEGER DEFAULT 0;
ALTER TABLE timeclock ADD COLUMN overtime_hours REAL DEFAULT 0;
ALTER TABLE timeclock ADD COLUMN attendance_status TEXT;  -- present | late | absent | early-departure | on-leave | holiday
ALTER TABLE timeclock ADD COLUMN notes TEXT;
ALTER TABLE timeclock ADD COLUMN approved_by TEXT;

CREATE INDEX IF NOT EXISTS idx_timeclock_staff_date ON timeclock(staff_id, date);

-- ─────────────────────────────────────────────────────────────────────────────
-- overtime — claimed, then approved, then paid
-- ─────────────────────────────────────────────────────────────────────────────
-- Its own table rather than a column on timeclock: overtime is approved by
-- somebody, at a rate that depends on when it was worked, and it has to be
-- traceable from the payslip back to the night in question.
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

CREATE INDEX IF NOT EXISTS idx_overtime_staff ON overtime(staff_id, date);
CREATE INDEX IF NOT EXISTS idx_overtime_status ON overtime(status);

-- ─────────────────────────────────────────────────────────────────────────────
-- leave
-- ─────────────────────────────────────────────────────────────────────────────
-- days is stored rather than computed from the dates, because half days and
-- non-working days in the middle of a request make the two different numbers.
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

CREATE INDEX IF NOT EXISTS idx_leave_staff  ON leave_requests(staff_id, start_date);
CREATE INDEX IF NOT EXISTS idx_leave_status ON leave_requests(status);
CREATE INDEX IF NOT EXISTS idx_leave_window ON leave_requests(start_date, end_date);

-- ─────────────────────────────────────────────────────────────────────────────
-- staff_adjustments — bonuses, deductions, advances
-- ─────────────────────────────────────────────────────────────────────────────
-- Signed `amount`: a bonus is positive, a deduction or a salary advance is
-- negative. One table rather than three, because they are the same act — money
-- moving between the business and a person outside the base salary — and the
-- payslip needs them in one list anyway.
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

CREATE INDEX IF NOT EXISTS idx_adjustments_staff ON staff_adjustments(staff_id, date);

-- ─────────────────────────────────────────────────────────────────────────────
-- payroll_runs — a period, closed once
-- ─────────────────────────────────────────────────────────────────────────────
-- The payslip lines are stored, not recomputed. Rates, bands and even a
-- person's salary change; a payslip issued in June must still say in December
-- what it said in June, for the same reason order lines snapshot their recipe.
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

CREATE INDEX IF NOT EXISTS idx_payroll_lines_run   ON payroll_lines(run_id);
CREATE INDEX IF NOT EXISTS idx_payroll_lines_staff ON payroll_lines(staff_id);
