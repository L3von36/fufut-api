/**
 * Employees: attendance, overtime, leave, adjustments and payroll.
 *
 * Covers §46 and the staff half of §51. What existed before: `timeclock` stamped
 * a clock-in and a clock-out, `shifts` said who was rostered, and that was all.
 * There was no way to say somebody was late, no record of overtime, no leave,
 * and nothing the accountant could be handed at the end of a month.
 *
 * ── Approval is a real gate ─────────────────────────────────────────────────
 * Overtime, leave and adjustments are all claimed by one person and approved by
 * another. Self-approval is refused explicitly rather than left to the role
 * matrix: a manager is allowed to approve overtime, and a manager approving
 * their *own* overtime is the case worth blocking.
 *
 * ── Payroll is a snapshot ───────────────────────────────────────────────────
 * A run stores its lines and the rates it used. Salaries, bands and multipliers
 * all change; a payslip issued in June has to still say in December what it
 * said in June — the same reasoning that makes order lines snapshot their
 * recipe.
 */

import { d1Query, d1Run, json, readBody } from '../lib/db.js';
import { writeAudit } from '../lib/audit.js';
import { actorName, isManager } from '../auth.js';
import { openChecksForStaff } from './orders.js';
import {
  classifyAttendance,
  overtimeAmount,
  payrollLine,
  settingsFromRows,
  isOnLeave,
} from '../lib/payroll.js';

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function round2(n) {
  return Math.round(num(n) * 100) / 100;
}
function today() {
  return new Date().toISOString().slice(0, 10);
}

export async function loadSettings(env) {
  try {
    const { results } = await d1Query(env, 'SELECT key, value FROM settings');
    return settingsFromRows(results || []);
  } catch {
    // Before migration 007 the table does not exist. Defaults keep attendance
    // classification working rather than failing the whole screen.
    return settingsFromRows([]);
  }
}

async function staffName(env, staffId) {
  const { results } = await d1Query(env, 'SELECT firstName, lastName FROM staff WHERE id = ?', [
    String(staffId),
  ]);
  const s = results && results[0];
  return s ? [s.firstName, s.lastName].filter(Boolean).join(' ') : null;
}

/**
 * Refuse self-approval.
 *
 * The role matrix says a manager may approve; it cannot say a manager may not
 * approve their own. That distinction is the entire control.
 */
function selfApproval(auth, ownerId) {
  return auth && auth.staff_id && String(auth.staff_id) === String(ownerId);
}

// ── Attendance ──────────────────────────────────────────────────────────────

/**
 * GET /api/attendance?from=&to=&staff_id=
 *
 * Classification is computed against the schedule and the settings in force,
 * and returned alongside the raw stamps so a disputed day can be checked rather
 * than argued about.
 */
async function attendance(env, url) {
  const from = url.searchParams.get('from') || today();
  const to = url.searchParams.get('to') || today();
  const staffId = url.searchParams.get('staff_id') || url.searchParams.get('staffId');

  const clauses = ['t.date >= ?', 't.date <= ?'];
  const params = [from, to];
  if (staffId) { clauses.push('t.staff_id = ?'); params.push(staffId); }

  const [{ results: rows }, { results: leave }, settings] = await Promise.all([
    d1Query(
      env,
      `SELECT t.*, s.firstName, s.lastName, s.role
         FROM timeclock t LEFT JOIN staff s ON s.id = t.staff_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY t.date DESC, t.staff_id`,
      params
    ),
    d1Query(
      env,
      "SELECT * FROM leave_requests WHERE status = 'approved' AND end_date >= ? AND start_date <= ?",
      [from, to]
    ).catch(() => ({ results: [] })),
    loadSettings(env),
  ]);

  const entries = (rows || []).map((r) => {
    const onLeave = isOnLeave(r.date, (leave || []).filter((l) => l.staff_id === r.staff_id));
    const classified = classifyAttendance(
      {
        clockIn: r.clock_in,
        clockOut: r.clock_out,
        hours: r.hours,
        scheduledStart: r.scheduled_start,
        scheduledEnd: r.scheduled_end,
        onLeave,
      },
      settings
    );
    return {
      ...r,
      staffName: [r.firstName, r.lastName].filter(Boolean).join(' '),
      ...classified,
    };
  });

  // The summary is what a manager actually looks at; the rows are the evidence.
  const summary = entries.reduce(
    (acc, e) => {
      acc[e.status] = (acc[e.status] || 0) + 1;
      acc.totalHours = round2(acc.totalHours + num(e.hoursWorked));
      acc.totalLateMinutes += num(e.lateMinutes);
      return acc;
    },
    { totalHours: 0, totalLateMinutes: 0 }
  );

  return json({ ok: true, from, to, summary, entries });
}

/** POST /api/attendance/:id/classify — persist the judgement on one day. */
async function persistClassification(request, env, auth, id) {
  const data = (await readBody(request)) || {};
  const { results } = await d1Query(env, 'SELECT * FROM timeclock WHERE id = ?', [id]);
  const row = results && results[0];
  if (!row) return json({ ok: false, error: 'Time clock entry not found' }, 404);

  const settings = await loadSettings(env);
  const classified = classifyAttendance(
    {
      clockIn: data.clockIn || row.clock_in,
      clockOut: data.clockOut || row.clock_out,
      hours: row.hours,
      scheduledStart: data.scheduledStart || row.scheduled_start,
      scheduledEnd: data.scheduledEnd || row.scheduled_end,
    },
    settings
  );

  await d1Run(
    env,
    `UPDATE timeclock
        SET scheduled_start = COALESCE(?, scheduled_start),
            scheduled_end   = COALESCE(?, scheduled_end),
            late_minutes = ?, early_leave_minutes = ?, overtime_hours = ?,
            attendance_status = ?, notes = COALESCE(?, notes), approved_by = ?
      WHERE id = ?`,
    [
      data.scheduledStart || null, data.scheduledEnd || null,
      classified.lateMinutes, classified.earlyLeaveMinutes, classified.overtimeHours,
      classified.status, data.notes || null, auth ? actorName(auth) : null, id,
    ]
  );

  await writeAudit(env, auth, {
    action: 'update', entity: 'timeclock', entityId: id,
    before: { attendance_status: row.attendance_status },
    after: { attendance_status: classified.status, late_minutes: classified.lateMinutes },
  });

  return json({ ok: true, ...classified });
}

// ── Overtime ────────────────────────────────────────────────────────────────

async function listOvertime(env, url) {
  const clauses = [];
  const params = [];
  const staffId = url.searchParams.get('staff_id') || url.searchParams.get('staffId');
  const status = url.searchParams.get('status');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (staffId) { clauses.push('staff_id = ?'); params.push(staffId); }
  if (status) { clauses.push('status = ?'); params.push(status); }
  if (from) { clauses.push('date >= ?'); params.push(from); }
  if (to) { clauses.push('date <= ?'); params.push(to); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const { results } = await d1Query(
    env,
    `SELECT * FROM overtime ${where} ORDER BY date DESC LIMIT 500`,
    params
  );
  return json(results || []);
}

async function createOvertime(request, env, auth) {
  const data = await readBody(request);
  if (!data) return json({ ok: false, error: 'Invalid JSON body' }, 400);

  const staffId = String(data.staffId || data.staff_id || (auth && auth.staff_id) || '');
  if (!staffId) return json({ ok: false, error: 'staffId required' }, 400);

  const hours = num(data.hours);
  if (hours <= 0) return json({ ok: false, error: 'Overtime hours must be greater than zero' }, 400);

  const { results } = await d1Query(env, 'SELECT * FROM staff WHERE id = ?', [staffId]);
  const staff = results && results[0];
  if (!staff) return json({ ok: false, error: 'Staff not found' }, 404);

  const settings = await loadSettings(env);
  // The multiplier and the rate are worked out now and stored, so a later
  // settings change cannot alter a claim that has already been approved.
  const valued = overtimeAmount(hours, staff.base_salary, data.kind || 'normal', settings);

  const id = 'OT' + crypto.randomUUID().slice(0, 9);
  const nowIso = new Date().toISOString();
  await d1Run(
    env,
    `INSERT INTO overtime
       (id, staff_id, staff_name, date, hours, kind, multiplier, hourly_rate, amount,
        reason, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [
      id, staffId, [staff.firstName, staff.lastName].filter(Boolean).join(' '),
      data.date || today(), valued.hours, valued.kind, valued.multiplier,
      valued.hourlyRate, valued.amount, data.reason || null,
      (auth && auth.staff_id) || null, nowIso,
    ]
  );

  await writeAudit(env, auth, {
    action: 'create', entity: 'overtime', entityId: id,
    after: { staff_id: staffId, hours: valued.hours, kind: valued.kind, amount: valued.amount },
  });

  return json({ ok: true, id, ...valued, status: 'pending' });
}

/** Approve or reject overtime, leave, or an adjustment. Shared shape. */
async function decide(request, env, auth, table, id, entityLabel) {
  const data = (await readBody(request)) || {};
  const { results } = await d1Query(env, `SELECT * FROM ${table} WHERE id = ?`, [id]);
  const row = results && results[0];
  if (!row) return json({ ok: false, error: `${entityLabel} not found` }, 404);
  if (row.status !== 'pending') {
    return json({ ok: false, error: `Already ${row.status}` }, 409);
  }

  if (selfApproval(auth, row.staff_id)) {
    return json(
      { ok: false, error: `You cannot approve your own ${entityLabel.toLowerCase()}` },
      403
    );
  }

  const approve = data.approve !== false;
  if (!approve && !data.reason) {
    return json({ ok: false, error: 'A reason is required to reject' }, 400);
  }

  const status = approve ? 'approved' : 'rejected';
  const nowIso = new Date().toISOString();
  await d1Run(
    env,
    `UPDATE ${table} SET status = ?, approved_by = ?, approved_at = ? WHERE id = ?`,
    [status, auth ? actorName(auth) : null, nowIso, id]
  );

  await writeAudit(env, auth, {
    action: 'update', entity: table, entityId: id,
    before: { status: row.status }, after: { status },
    reason: data.reason || null,
  });

  return json({ ok: true, status });
}

// ── Leave ───────────────────────────────────────────────────────────────────

async function listLeave(env, url) {
  const clauses = [];
  const params = [];
  const staffId = url.searchParams.get('staff_id') || url.searchParams.get('staffId');
  const status = url.searchParams.get('status');
  if (staffId) { clauses.push('staff_id = ?'); params.push(staffId); }
  if (status) { clauses.push('status = ?'); params.push(status); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const { results } = await d1Query(
    env,
    `SELECT * FROM leave_requests ${where} ORDER BY start_date DESC LIMIT 500`,
    params
  );
  return json(results || []);
}

async function createLeave(request, env, auth) {
  const data = await readBody(request);
  if (!data) return json({ ok: false, error: 'Invalid JSON body' }, 400);

  const staffId = String(data.staffId || data.staff_id || (auth && auth.staff_id) || '');
  const start = data.startDate || data.start_date;
  const end = data.endDate || data.end_date || start;
  if (!staffId || !start) return json({ ok: false, error: 'staffId and startDate required' }, 400);
  if (end < start) return json({ ok: false, error: 'Leave cannot end before it starts' }, 400);

  // Overlapping approved leave is a scheduling error worth catching at entry:
  // two approved requests for the same days make the payroll day count wrong.
  const { results: clash } = await d1Query(
    env,
    `SELECT id FROM leave_requests
      WHERE staff_id = ? AND status IN ('approved','pending')
        AND start_date <= ? AND end_date >= ? LIMIT 1`,
    [staffId, end, start]
  );
  if (clash && clash.length) {
    return json({ ok: false, error: 'This overlaps an existing leave request' }, 409);
  }

  // Inclusive of both ends, which is how people describe leave.
  const days = data.days !== undefined
    ? num(data.days)
    : Math.max(1, Math.round((new Date(end) - new Date(start)) / 86400000) + 1);

  const id = 'LV' + crypto.randomUUID().slice(0, 9);
  const nowIso = new Date().toISOString();
  await d1Run(
    env,
    `INSERT INTO leave_requests
       (id, staff_id, staff_name, type, start_date, end_date, days, paid, reason,
        status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [
      id, staffId, await staffName(env, staffId), data.type || 'annual',
      start, end, days, data.paid === false ? 0 : 1, data.reason || null,
      (auth && auth.staff_id) || null, nowIso,
    ]
  );

  await writeAudit(env, auth, {
    action: 'create', entity: 'leave_requests', entityId: id,
    after: { staff_id: staffId, type: data.type || 'annual', start, end, days },
  });

  return json({ ok: true, id, days, status: 'pending' });
}

// ── Adjustments ─────────────────────────────────────────────────────────────

async function listAdjustments(env, url) {
  const clauses = [];
  const params = [];
  const staffId = url.searchParams.get('staff_id') || url.searchParams.get('staffId');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (staffId) { clauses.push('staff_id = ?'); params.push(staffId); }
  if (from) { clauses.push('date >= ?'); params.push(from); }
  if (to) { clauses.push('date <= ?'); params.push(to); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const { results } = await d1Query(
    env,
    `SELECT * FROM staff_adjustments ${where} ORDER BY date DESC LIMIT 500`,
    params
  );
  return json(results || []);
}

async function createAdjustment(request, env, auth) {
  const data = await readBody(request);
  if (!data) return json({ ok: false, error: 'Invalid JSON body' }, 400);

  const staffId = String(data.staffId || data.staff_id || '');
  if (!staffId) return json({ ok: false, error: 'staffId required' }, 400);

  const type = String(data.type || '').toLowerCase();
  const magnitude = Math.abs(num(data.amount));
  if (!magnitude) return json({ ok: false, error: 'Amount must be non-zero' }, 400);
  if (!data.reason) {
    // A bonus or a deduction with no reason is unanswerable at the moment
    // somebody queries their payslip, which is the only moment it matters.
    return json({ ok: false, error: 'A reason is required' }, 400);
  }

  // The sign is derived from the type rather than trusted from the client, so a
  // deduction cannot arrive as a positive number and quietly become a bonus.
  const negative = ['deduction', 'advance', 'penalty'].includes(type);
  const amount = negative ? -magnitude : magnitude;

  const id = 'SA' + crypto.randomUUID().slice(0, 9);
  const nowIso = new Date().toISOString();
  await d1Run(
    env,
    `INSERT INTO staff_adjustments
       (id, staff_id, staff_name, date, type, amount, taxable, reason, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [
      id, staffId, await staffName(env, staffId), data.date || today(),
      type || 'bonus', amount,
      data.taxable === false ? 0 : 1, String(data.reason).trim(),
      (auth && auth.staff_id) || null, nowIso,
    ]
  );

  await writeAudit(env, auth, {
    action: 'create', entity: 'staff_adjustments', entityId: id,
    after: { staff_id: staffId, type, amount },
    reason: String(data.reason).trim(),
  });

  return json({ ok: true, id, amount });
}

// ── Payroll ─────────────────────────────────────────────────────────────────

/**
 * POST /api/payroll/run — build a period's payslips.
 *
 * Only approved overtime and approved adjustments are included: a pending claim
 * is a request, not a liability, and paying one would remove the point of the
 * approval step.
 */
async function runPayroll(request, env, auth) {
  const data = (await readBody(request)) || {};
  const start = data.periodStart || data.period_start;
  const end = data.periodEnd || data.period_end;
  if (!start || !end) return json({ ok: false, error: 'periodStart and periodEnd are required' }, 400);

  const settings = await loadSettings(env);

  const [{ results: staff }, { results: ot }, { results: adj }, { results: tips }, { results: att }] =
    await Promise.all([
      d1Query(env, "SELECT * FROM staff WHERE status = 'active'"),
      d1Query(env, "SELECT * FROM overtime WHERE status = 'approved' AND date >= ? AND date <= ?", [start, end]),
      d1Query(env, "SELECT * FROM staff_adjustments WHERE status IN ('approved','pending') AND date >= ? AND date <= ?", [start, end]),
      d1Query(env, 'SELECT staff_id, SUM(amount) AS total FROM tips WHERE date >= ? AND date <= ? GROUP BY staff_id', [start, end])
        .catch(() => ({ results: [] })),
      d1Query(env, 'SELECT staff_id, attendance_status, COUNT(*) AS n FROM timeclock WHERE date >= ? AND date <= ? GROUP BY staff_id, attendance_status', [start, end])
        .catch(() => ({ results: [] })),
    ]);

  const byStaff = (rows, key = 'staff_id') => {
    const m = new Map();
    for (const r of rows || []) {
      const k = String(r[key]);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  };

  const otBy = byStaff(ot);
  const adjBy = byStaff(adj);
  const tipsBy = new Map((tips || []).map((t) => [String(t.staff_id), num(t.total)]));
  const attBy = byStaff(att);

  const runId = 'PR' + crypto.randomUUID().slice(0, 9);
  const nowIso = new Date().toISOString();
  const lines = [];

  for (const person of staff || []) {
    const key = String(person.id);
    const days = attBy.get(key) || [];
    const worked = days.filter((d) => d.attendance_status !== 'absent').reduce((s, d) => s + num(d.n), 0);
    const absent = days.filter((d) => d.attendance_status === 'absent').reduce((s, d) => s + num(d.n), 0);

    const line = payrollLine({
      staff: person,
      overtimeEntries: otBy.get(key) || [],
      // Only approved adjustments are money owed; a pending one is a request.
      adjustments: (adjBy.get(key) || []).filter((a) => a.status === 'approved'),
      tips: tipsBy.get(key) || 0,
      daysWorked: worked,
      daysAbsent: absent,
      settings,
    });
    lines.push(line);
  }

  const totals = lines.reduce(
    (acc, l) => ({
      gross: acc.gross + l.grossPay,
      tax: acc.tax + l.incomeTax,
      pension: acc.pension + l.pensionEmployee,
      net: acc.net + l.netPay,
    }),
    { gross: 0, tax: 0, pension: 0, net: 0 }
  );

  await d1Run(
    env,
    `INSERT INTO payroll_runs
       (id, period_start, period_end, status, gross_total, tax_total, pension_total,
        net_total, provisional, notes, created_by, created_by_name, created_at)
     VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      runId, start, end, round2(totals.gross), round2(totals.tax), round2(totals.pension),
      round2(totals.net), settings.unverified ? 1 : 0, data.notes || null,
      (auth && auth.staff_id) || null, auth ? actorName(auth) : null, nowIso,
    ]
  );

  for (const l of lines) {
    await d1Run(
      env,
      `INSERT INTO payroll_lines
         (id, run_id, staff_id, staff_name, base_salary, overtime_pay, bonuses, deductions,
          gross_pay, taxable_pay, income_tax, pension_employee, pension_employer, net_pay,
          tips_earned, days_worked, days_absent, breakdown, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'PL' + crypto.randomUUID().slice(0, 9), runId, l.staffId, l.staffName,
        l.baseSalary, l.overtimePay, l.bonuses, l.deductions, l.grossPay, l.taxablePay,
        l.incomeTax, l.pensionEmployee, l.pensionEmployer, l.netPay, l.tipsEarned,
        l.daysWorked, l.daysAbsent, JSON.stringify(l.breakdown), nowIso,
      ]
    );
  }

  await writeAudit(env, auth, {
    action: 'create', entity: 'payroll_runs', entityId: runId,
    after: { period: `${start}..${end}`, staff: lines.length, net: round2(totals.net) },
  });

  return json({
    ok: true,
    runId,
    period: { start, end },
    staffCount: lines.length,
    totals: {
      gross: round2(totals.gross), tax: round2(totals.tax),
      pension: round2(totals.pension), net: round2(totals.net),
    },
    lines,
    // Surfaced on every response, not buried in a settings screen: a payslip
    // computed from rates nobody has confirmed must not look authoritative.
    provisional: settings.unverified,
    warning: settings.unverified
      ? 'Tax bands, pension and overtime rates have not been confirmed. Have an accountant verify them in Settings before treating this as final.'
      : undefined,
  });
}

async function listPayrollRuns(env, url) {
  const runId = url.searchParams.get('run_id') || url.searchParams.get('runId');
  if (runId) {
    const [{ results: runs }, { results: lines }] = await Promise.all([
      d1Query(env, 'SELECT * FROM payroll_runs WHERE id = ?', [runId]),
      d1Query(env, 'SELECT * FROM payroll_lines WHERE run_id = ? ORDER BY staff_name', [runId]),
    ]);
    if (!runs || !runs.length) return json({ ok: false, error: 'Payroll run not found' }, 404);
    return json({ ok: true, run: runs[0], lines: lines || [] });
  }
  const { results } = await d1Query(env, 'SELECT * FROM payroll_runs ORDER BY period_start DESC LIMIT 100');
  return json({ ok: true, runs: results || [] });
}

// ── Settings ────────────────────────────────────────────────────────────────

async function getSettings(env, url) {
  const category = url.searchParams.get('category');
  const { results } = await d1Query(
    env,
    category ? 'SELECT * FROM settings WHERE category = ? ORDER BY key' : 'SELECT * FROM settings ORDER BY category, key',
    category ? [category] : []
  );
  return json({ ok: true, settings: results || [] });
}

async function putSetting(request, env, auth, key) {
  const data = await readBody(request);
  if (!data || data.value === undefined) return json({ ok: false, error: 'value required' }, 400);

  const { results } = await d1Query(env, 'SELECT * FROM settings WHERE key = ?', [key]);
  const existing = results && results[0];
  const value = typeof data.value === 'string' ? data.value : JSON.stringify(data.value);
  const nowIso = new Date().toISOString();

  if (existing) {
    await d1Run(env, 'UPDATE settings SET value = ?, updated_at = ?, updated_by = ? WHERE key = ?', [
      value, nowIso, auth ? actorName(auth) : null, key,
    ]);
  } else {
    await d1Run(
      env,
      'INSERT INTO settings (key, value, category, label, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)',
      [key, value, data.category || null, data.label || null, nowIso, auth ? actorName(auth) : null]
    );
  }

  // A tax band or a pension rate changing is exactly the kind of thing that has
  // to be answerable months later.
  await writeAudit(env, auth, {
    action: 'update', entity: 'settings', entityId: key,
    before: existing ? { value: existing.value } : null,
    after: { value },
    reason: data.reason || null,
  });

  return json({ ok: true, key, value });
}

// ── Router ──────────────────────────────────────────────────────────────────

// ── Clocking on and off ─────────────────────────────────────────────────────

/**
 * The shop is UTC+3 with no daylight saving, and `timeclock` holds local wall
 * clock: date "2026-08-17", clock_in "09:00". Storing UTC here would put every
 * shift three hours out and quietly corrupt the hours payroll pays on.
 */
const SHOP_OFFSET_MIN = 180;

function shopNow(nowMs = Date.now()) {
  const local = new Date(nowMs + SHOP_OFFSET_MIN * 60000);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    date: `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`,
    time: `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`,
  };
}

/**
 * Whose record is being acted on.
 *
 * A staffId is honoured only for a manager; everyone else acts on themselves
 * whatever they send. This is the whole security model of the self-service
 * routes, so it is one function rather than a check repeated three times.
 */
function subjectStaffId(data, auth) {
  const own = (auth && auth.staff_id) || null;
  const asked = data && (data.staffId || data.staff_id);
  if (asked && isManager((auth && (auth.sessionRole || auth.role)) || '')) return String(asked);
  return own;
}

/** The shift this person has open, if any. */
async function openEntryFor(env, staffId) {
  const { results } = await d1Query(
    env,
    `SELECT * FROM timeclock
      WHERE staff_id = ? AND (clock_out IS NULL OR TRIM(clock_out) = '')
      ORDER BY date DESC, clock_in DESC
      LIMIT 1`,
    [String(staffId)]
  );
  return (results || [])[0] || null;
}

/** GET /api/timeclock/me — am I on shift, and what is still owed on my tables? */
async function whoIsOnShift(env, url, auth) {
  const asked = url && url.searchParams ? url.searchParams.get('staffId') : null;
  const staffId = subjectStaffId({ staffId: asked }, auth);
  if (!staffId) return json({ ok: false, error: 'No staff record on this session' }, 400);

  const [entry, checks] = await Promise.all([
    openEntryFor(env, staffId),
    openChecksForStaff(env, staffId),
  ]);

  return json({
    ok: true,
    staffId,
    clockedIn: !!entry,
    entry: entry || null,
    openChecks: checks.map((c) => ({
      id: c.id,
      table: c.table_id || null,
      total: c.total,
      created: c.created,
      paymentStatus: c.payment_status || 'unpaid',
    })),
  });
}

/**
 * GET /api/timeclock/me/history — my own recent shifts, newest first.
 *
 * The Time Clock screen for a role without the roster grant showed the current
 * state and the two buttons and nothing else: the only member of staff whose
 * hours a waiter can affect is the one whose hours they could not see. This
 * answers exactly the caller's own rows — subjectStaffId honours a staffId
 * only for a manager, who already holds the roster — so nobody reads a
 * colleague's record through it.
 */
async function myHistory(env, url, auth) {
  const asked = url && url.searchParams ? url.searchParams.get('staffId') : null;
  const staffId = subjectStaffId({ staffId: asked }, auth);
  if (!staffId) return json({ ok: false, error: 'No staff record on this session' }, 400);

  const limitRaw = parseInt((url && url.searchParams.get('limit')) || '14', 10);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 14, 1), 90);

  const { results } = await d1Query(
    env,
    `SELECT * FROM timeclock
      WHERE staff_id = ?
      ORDER BY date DESC, clock_in DESC
      LIMIT ?`,
    [String(staffId), limit]
  );

  const entries = (results || []).map((r) => ({
    ...r,
    // The POS roster table reads both spellings; give it the one it prefers.
    staffId: r.staff_id,
    clockIn: r.clock_in,
    clockOut: r.clock_out && String(r.clock_out).trim() !== '' ? r.clock_out : null,
  }));

  return json({ ok: true, staffId, entries });
}

/**
 * GET /api/timeclock — the roster, honouring staff_id/staffId, from and to.
 *
 * Shape matches the generic handler it replaces: a bare array, newest first by
 * created. No filters given is the whole roster, which is what the Time Clock
 * and Shifts screens read. The staff join is new: the generic handler returned
 * raw rows, so the POS roster table's STAFF column has always read "—" —
 * rows carry staff_id, never a name.
 */
async function listTimeclock(env, url) {
  const sp = url && url.searchParams ? url.searchParams : new URLSearchParams();
  const staffId = sp.get('staff_id') || sp.get('staffId');
  const from = sp.get('from');
  const to = sp.get('to');

  const clauses = [];
  const params = [];
  if (from) { clauses.push('t.date >= ?'); params.push(from); }
  if (to) { clauses.push('t.date <= ?'); params.push(to); }
  if (staffId) { clauses.push('t.staff_id = ?'); params.push(String(staffId)); }

  const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
  const { results } = await d1Query(
    env,
    `SELECT t.*, s.firstName, s.lastName
       FROM timeclock t LEFT JOIN staff s ON s.id = t.staff_id${where}
      ORDER BY t.created DESC`,
    params
  );
  const rows = (results || []).map((r) => ({
    ...r,
    staffName: [r.firstName, r.lastName].filter(Boolean).join(' ') || null,
  }));
  return json(rows);
}

/** POST /api/timeclock/clock-in */
async function clockIn(request, env, auth) {
  const data = (await readBody(request)) || {};
  const staffId = subjectStaffId(data, auth);
  if (!staffId) return json({ ok: false, error: 'No staff record on this session' }, 400);

  const existing = await openEntryFor(env, staffId);
  // Tapping twice must not open a second shift and double-count the hours.
  if (existing) {
    return json({ ok: false, error: 'Already clocked in.', entry: existing }, 409);
  }

  const { date, time } = shopNow();
  const id = 'TC' + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  await d1Run(
    env,
    `INSERT INTO timeclock (id, staff_id, date, clock_in, clock_out, hours, status, created)
     VALUES (?, ?, ?, ?, '', 0, 'active', ?)`,
    [id, String(staffId), date, time, new Date().toISOString()]
  );

  await writeAudit(env, auth, {
    action: 'create', entity: 'timeclock', entityId: id,
    after: { staff_id: staffId, date, clock_in: time },
  });

  return json({ ok: true, id, staffId, date, clockIn: time });
}

/**
 * POST /api/timeclock/clock-out — the shift gate.
 *
 * A check that is still open when its waiter goes home is how a bill is never
 * collected: the table gets cleared by somebody else, and by the morning nobody
 * remembers who was sitting there. This is the point in the day where it is
 * still cheap to fix, which is why professional tills refuse the clock-out
 * rather than warning about it.
 *
 * A manager may override, because somebody has to be able to send a person home
 * when a check is genuinely stuck — but they must say so with `force`, and it
 * is written to the audit log with the checks that were left. A silent manager
 * exemption would make the gate meaningless the moment it was inconvenient.
 */
async function clockOut(request, env, auth) {
  const data = (await readBody(request)) || {};
  const staffId = subjectStaffId(data, auth);
  if (!staffId) return json({ ok: false, error: 'No staff record on this session' }, 400);

  const entry = await openEntryFor(env, staffId);
  if (!entry) return json({ ok: false, error: 'Not clocked in.' }, 409);

  const outstanding = await openChecksForStaff(env, staffId);
  const manager = isManager((auth && (auth.sessionRole || auth.role)) || '');
  const forced = data.force === true && manager;

  if (outstanding.length && !forced) {
    const owed = outstanding.reduce((sum, c) => sum + (Number(c.total) || 0), 0);
    return json(
      {
        ok: false,
        error: `${outstanding.length} check${outstanding.length === 1 ? '' : 's'} still open, ETB ${Math.round(owed)} owed. Settle or hand them over before clocking out.`,
        openChecks: outstanding.map((c) => ({
          id: c.id,
          table: c.table_id || null,
          total: c.total,
          created: c.created,
        })),
        totalOwed: Math.round(owed),
        managerCanOverride: true,
      },
      409
    );
  }

  const { time } = shopNow();
  const worked = minutesWorked(entry.clock_in, time);

  await d1Run(
    env,
    `UPDATE timeclock SET clock_out = ?, hours = ?, status = 'completed' WHERE id = ?`,
    [time, Math.round((worked / 60) * 100) / 100, entry.id]
  );

  await writeAudit(env, auth, {
    action: 'update', entity: 'timeclock', entityId: entry.id,
    before: { clock_out: null },
    after: {
      clock_out: time,
      hours: Math.round((worked / 60) * 100) / 100,
      // Recorded on the entry itself: an override is the fact worth keeping.
      forced_with_open_checks: forced ? outstanding.map((c) => c.id) : undefined,
    },
  });

  return json({ ok: true, id: entry.id, clockOut: time, hours: Math.round((worked / 60) * 100) / 100, forced });
}

/** Minutes between two "HH:MM" stamps, treating a wrap as a shift past midnight. */
function minutesWorked(from, to) {
  const parse = (t) => {
    const m = String(t || '').match(/^(\d{1,2}):(\d{2})/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const a = parse(from);
  const b = parse(to);
  if (a === null || b === null) return 0;
  return b < a ? b + 1440 - a : b - a;
}

export async function handleHR(pathname, method, url, request, env, auth) {
  const m = method.toUpperCase();

  // Self-service, ahead of the generic timeclock resource. See SELF_SERVICE in
  // auth.js for why these are reachable by every role.
  if (pathname === '/api/timeclock/me' && m === 'GET') return whoIsOnShift(env, url, auth);
  if (pathname === '/api/timeclock/me/history' && m === 'GET') return myHistory(env, url, auth);
  if (pathname === '/api/timeclock/clock-in' && m === 'POST') return clockIn(request, env, auth);
  if (pathname === '/api/timeclock/clock-out' && m === 'POST') return clockOut(request, env, auth);

  // The roster list, ahead of the generic resource handler. That handler
  // ignores the query string entirely: a caller asking for
  // /api/timeclock?staff_id=S6&from=…&to=… was answered with EVERY row, and a
  // cleanup script trusted that and deleted eight people's attendance records
  // on the strength of it (D1 Time Travel restored them; worklog 2026-08-27).
  // An API that answers a filtered question with an unfiltered answer is a
  // loaded footgun, so the filters are honoured here.
  if (pathname === '/api/timeclock' && m === 'GET') return listTimeclock(env, url);

  if (pathname.startsWith('/api/attendance')) {
    const sub = pathname.replace(/^\/api\/attendance/, '');
    if (m === 'GET' && sub === '') return attendance(env, url);
    const cls = sub.match(/^\/([^/]+)\/classify$/);
    if (m === 'POST' && cls) return persistClassification(request, env, auth, cls[1]);
  }

  if (pathname.startsWith('/api/overtime')) {
    const sub = pathname.replace(/^\/api\/overtime/, '');
    if (m === 'GET' && sub === '') return listOvertime(env, url);
    if (m === 'POST' && sub === '') return createOvertime(request, env, auth);
    const dec = sub.match(/^\/([^/]+)\/decide$/);
    if (m === 'POST' && dec) return decide(request, env, auth, 'overtime', dec[1], 'Overtime claim');
  }

  if (pathname.startsWith('/api/leave')) {
    const sub = pathname.replace(/^\/api\/leave/, '');
    if (m === 'GET' && sub === '') return listLeave(env, url);
    if (m === 'POST' && sub === '') return createLeave(request, env, auth);
    const dec = sub.match(/^\/([^/]+)\/decide$/);
    if (m === 'POST' && dec) return decide(request, env, auth, 'leave_requests', dec[1], 'Leave request');
  }

  if (pathname.startsWith('/api/adjustments')) {
    const sub = pathname.replace(/^\/api\/adjustments/, '');
    if (m === 'GET' && sub === '') return listAdjustments(env, url);
    if (m === 'POST' && sub === '') return createAdjustment(request, env, auth);
    const dec = sub.match(/^\/([^/]+)\/decide$/);
    if (m === 'POST' && dec) return decide(request, env, auth, 'staff_adjustments', dec[1], 'Adjustment');
  }

  if (pathname.startsWith('/api/payroll')) {
    const sub = pathname.replace(/^\/api\/payroll/, '');
    if (m === 'GET' && sub === '') return listPayrollRuns(env, url);
    if (m === 'POST' && sub === '/run') {
      if (!isManager((auth && (auth.sessionRole || auth.role)) || '')) {
        return json({ ok: false, error: 'Only a manager can run payroll' }, 403);
      }
      return runPayroll(request, env, auth);
    }
  }

  if (pathname.startsWith('/api/settings')) {
    const sub = pathname.replace(/^\/api\/settings/, '');
    if (m === 'GET' && sub === '') return getSettings(env, url);
    const one = sub.match(/^\/(.+)$/);
    if (m === 'PUT' && one) {
      if (!isManager((auth && (auth.sessionRole || auth.role)) || '')) {
        return json({ ok: false, error: 'Only a manager can change business settings' }, 403);
      }
      return putSetting(request, env, auth, decodeURIComponent(one[1]));
    }
  }

  if (pathname.startsWith('/api/hr/schedule')) {
    const sub = pathname.replace(/^\/api\/hr\/schedule/, '');
    if (m === 'GET' && (sub === '' || sub === '/')) {
      const from = url.searchParams.get('from') || today();
      const to = url.searchParams.get('to') || today();
      const { results: shifts } = await d1Query(env, `
        SELECT s.*, st.firstName, st.lastName, st.role
          FROM shifts s JOIN staff st ON st.id = s.staff_id
         WHERE date(s.start_time) >= ? AND date(s.start_time) <= ?
         ORDER BY s.start_time ASC
      `, [from, to]).catch(() => ({ results: [] }));

      const { results: leaves } = await d1Query(env, `
        SELECT * FROM leave_requests WHERE status = 'approved' AND start_date <= ? AND end_date >= ?
      `, [to, from]).catch(() => ({ results: [] }));

      return json({ ok: true, schedule: shifts || [], conflicts: leaves || [] });
    }

    if (m === 'POST' && (sub === '' || sub === '/')) {
      if (!isManager((auth && (auth.sessionRole || auth.role)) || '')) {
        return json({ ok: false, error: 'Only a manager can assign shifts' }, 403);
      }
      const data = await readBody(request);
      if (!data || !data.staffId || !data.startTime || !data.endTime) {
        return json({ ok: false, error: 'staffId, startTime, and endTime required' }, 400);
      }
      const id = `SHF-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const nowIso = new Date().toISOString();
      await d1Run(env, `
        INSERT INTO shifts (id, staff_id, role, start_time, end_time, status, notes, created_at)
        VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?)
      `, [id, data.staffId, data.role || 'staff', data.startTime, data.endTime, data.notes || null, nowIso]);

      await writeAudit(env, auth, { action: 'create', entity: 'shifts', entityId: id, after: { staffId: data.staffId, startTime: data.startTime } });
      return json({ ok: true, id, staffId: data.staffId, startTime: data.startTime, endTime: data.endTime });
    }

    const one = sub.match(/^\/([^/]+)$/);
    if (m === 'DELETE' && one) {
      if (!isManager((auth && (auth.sessionRole || auth.role)) || '')) {
        return json({ ok: false, error: 'Only a manager can delete shifts' }, 403);
      }
      await d1Run(env, 'DELETE FROM shifts WHERE id = ?', [one[1]]);
      await writeAudit(env, auth, { action: 'delete', entity: 'shifts', entityId: one[1] });
      return json({ ok: true, id: one[1] });
    }
  }

  // ── Employee Activity module (Phase 1) ────────────────────────────────
  //
  // Two endpoints that give managers the "who worked, what did they do"
  // visibility the existing separate views (Staff, Time Clock, Attendance,
  // Audit Log) don't provide on their own. Both reuse the existing timeclock
  // + audit_log tables — no new migrations needed.

  if (pathname.startsWith('/api/employees')) {
    const sub = pathname.replace(/^\/api\/employees/, '');

    // GET /api/employees/activity?from=&to=
    // Manager dashboard: who worked in the range, clock-in/out, late flags,
    // summary cards (working today, late, absent, total hours).
    if (m === 'GET' && (sub === '/activity' || sub === '/activity/')) {
      if (!isManager((auth && (auth.sessionRole || auth.role)) || '')) {
        return json({ ok: false, error: 'Only a manager can view employee activity' }, 403);
      }
      const sp = url.searchParams;
      const from = sp.get('from') || today();
      const to = sp.get('to') || today();

      // Active staff (not deleted/inactive)
      const { results: staffRows } = await d1Query(
        env,
        "SELECT id, firstName, lastName, role, status FROM staff WHERE status = 'active' ORDER BY firstName, lastName"
      );

      // Timeclock entries in range
      const { results: clockRows } = await d1Query(
        env,
        'SELECT * FROM timeclock WHERE date >= ? AND date <= ? ORDER BY clock_in DESC',
        [from, to]
      );

      // Build a map of staffId → timeclock entries
      const clocksByStaff = new Map();
      for (const c of clockRows || []) {
        if (!clocksByStaff.has(c.staff_id)) clocksByStaff.set(c.staff_id, []);
        clocksByStaff.get(c.staff_id).push(c);
      }

      // Build employee activity list
      const employees = (staffRows || []).map((s) => {
        const clocks = clocksByStaff.get(s.id) || [];
        const latest = clocks[0]; // newest first (already sorted DESC)
        const totalHours = clocks.reduce((sum, c) => sum + (c.hours || 0), 0);
        const totalLate = clocks.reduce((sum, c) => sum + (c.late_minutes || 0), 0);
        const totalOvertime = clocks.reduce((sum, c) => sum + (c.overtime_hours || 0), 0);
        const isWorking = latest && latest.status === 'open';
        const isLate = clocks.some((c) => (c.late_minutes || 0) > 0);
        return {
          id: s.id,
          name: `${s.firstName || ''} ${s.lastName || ''}`.trim(),
          role: s.role,
          status: s.status,
          isWorking,
          clockIn: latest?.clock_in || null,
          clockOut: latest?.clock_out || null,
          shifts: clocks.length,
          totalHours: Math.round(totalHours * 10) / 10,
          totalLateMinutes: totalLate,
          totalOvertimeHours: Math.round(totalOvertime * 10) / 10,
          isLate,
          attendanceStatus: latest?.attendance_status || (clocks.length ? 'present' : 'absent'),
        };
      });

      // Summary cards
      const workingToday = employees.filter((e) => e.isWorking).length;
      const presentToday = employees.filter((e) => e.shifts > 0).length;
      const lateToday = employees.filter((e) => e.isLate).length;
      const absentToday = employees.filter((e) => e.shifts === 0).length;
      const totalHours = employees.reduce((s, e) => s + e.totalHours, 0);

      return json({
        ok: true,
        from,
        to,
        summary: {
          totalEmployees: employees.length,
          workingNow: workingToday,
          presentToday,
          lateToday,
          absentToday,
          totalHours: Math.round(totalHours * 10) / 10,
        },
        employees,
      });
    }

    // GET /api/employees/:id/history?from=&to=
    // Per-employee detail: profile + timeline (audit_log + timeclock merged
    // chronologically) + role-specific KPI counts.
    const histMatch = sub.match(/^\/([^/]+)\/history$/);
    if (m === 'GET' && histMatch) {
      const staffId = histMatch[1];
      const role = String((auth && (auth.sessionRole || auth.role)) || '').toLowerCase();
      const isMe = auth && auth.staff_id === staffId;
      // Self can read own; manager can read anyone. Others get 403.
      if (!isManager(role) && !isMe) {
        return json({ ok: false, error: 'You can only view your own history' }, 403);
      }

      const sp = url.searchParams;
      const from = sp.get('from') || today();
      const to = sp.get('to') || today();

      // Profile
      const { results: staffRows } = await d1Query(
        env,
        'SELECT * FROM staff WHERE id = ?',
        [String(staffId)]
      );
      const staff = (staffRows || [])[0];
      if (!staff) return json({ ok: false, error: 'Employee not found' }, 404);

      // Timeclock entries in range
      const { results: clockRows } = await d1Query(
        env,
        'SELECT * FROM timeclock WHERE staff_id = ? AND date >= ? AND date <= ? ORDER BY clock_in DESC',
        [String(staffId), from, to]
      );

      // Audit log entries in range
      const { results: auditRows } = await d1Query(
        env,
        'SELECT * FROM audit_log WHERE actor_id = ? AND at >= ? AND at <= ? ORDER BY at DESC LIMIT 500',
        [String(staffId), from, to + 'T23:59:59']
      );

      // Build a merged timeline: timeclock events + audit events, sorted by time
      const timeline = [];
      for (const c of clockRows || []) {
        if (c.clock_in) timeline.push({ type: 'clock_in', at: c.clock_in, label: 'Clocked in', entry_id: c.id });
        if (c.clock_out) timeline.push({ type: 'clock_out', at: c.clock_out, label: 'Clocked out', entry_id: c.id });
      }
      for (const a of auditRows || []) {
        timeline.push({
          type: 'audit',
          at: a.at,
          label: a.action,
          entity: a.entity,
          entity_id: a.entity_id,
          before: a.before,
          after: a.after,
          reason: a.reason,
        });
      }
      timeline.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));

      // Role-specific KPIs (counts from the audit slice)
      const countBy = (pred) => (auditRows || []).filter(pred).length;
      const roleKey = String(staff.role || '').toLowerCase();
      const kpis = [];
      if (roleKey === 'manager') {
        kpis.push(
          { label: 'Orders Touched', value: countBy((e) => e.entity === 'orders') },
          { label: 'Payments', value: countBy((e) => e.entity === 'payments') },
          { label: 'Staff Edits', value: countBy((e) => e.entity === 'staff') },
          { label: 'Attendance Corrections', value: countBy((e) => e.entity === 'timeclock') },
        );
      } else if (roleKey === 'head-chef' || roleKey === 'assistant-chef') {
        kpis.push(
          { label: 'Dishes Sent', value: countBy((e) => e.entity === 'orders' && e.after && (e.after.status === 'ready' || e.after.status === 'served')) },
          { label: 'Tickets Started', value: countBy((e) => e.entity === 'orders' && e.after && e.after.status === 'preparing') },
          { label: 'Inventory Adjustments', value: countBy((e) => e.entity === 'inventory') },
          { label: 'Waste Logged', value: countBy((e) => e.entity === 'waste') },
        );
      } else if (roleKey === 'head-waiter') {
        kpis.push(
          { label: 'Orders Taken', value: countBy((e) => e.entity === 'orders' && e.action === 'create') },
          { label: 'Tables Seated', value: countBy((e) => e.entity === 'tables' && e.after && e.after.status === 'occupied') },
          { label: 'Tips Recorded', value: countBy((e) => e.entity === 'tips') },
          { label: 'Reservations', value: countBy((e) => e.entity === 'reservations') },
        );
      } else if (roleKey === 'cashier') {
        kpis.push(
          { label: 'Payments Verified', value: countBy((e) => e.entity === 'payments' && (e.action === 'verify' || e.action === 'create')) },
          { label: 'Refunds Issued', value: countBy((e) => e.entity === 'payments' && e.action === 'refund') },
          { label: 'Cash Drawer Ops', value: countBy((e) => e.entity === 'cashdrawer') },
          { label: 'Orders Settled', value: countBy((e) => e.entity === 'orders' && e.after && /paid|settled|completed/.test(e.after.status || '')) },
        );
      } else if (roleKey === 'delivery-staff') {
        kpis.push(
          { label: 'Jobs Taken', value: countBy((e) => e.entity === 'delivery' && e.after && e.after.status === 'assigned') },
          { label: 'Delivered', value: countBy((e) => e.entity === 'delivery' && e.after && e.after.status === 'delivered') },
          { label: 'Payments Recorded', value: countBy((e) => e.entity === 'payments' && e.action === 'create') },
          { label: 'Tips', value: countBy((e) => e.entity === 'tips') },
        );
      } else if (roleKey === 'cleaner') {
        kpis.push(
          { label: 'Waste Logged', value: countBy((e) => e.entity === 'waste') },
          { label: 'Tables Cleared', value: countBy((e) => e.entity === 'tables' && e.after && e.after.status === 'available') },
        );
      }

      // Attendance summary
      const totalHours = (clockRows || []).reduce((s, c) => s + (c.hours || 0), 0);
      const totalLate = (clockRows || []).reduce((s, c) => s + (c.late_minutes || 0), 0);

      return json({
        ok: true,
        staff: {
          id: staff.id,
          firstName: staff.firstName,
          lastName: staff.lastName,
          role: staff.role,
          status: staff.status,
          email: staff.email,
          phone: staff.phone,
        },
        from,
        to,
        attendance: {
          shifts: (clockRows || []).length,
          totalHours: Math.round(totalHours * 10) / 10,
          totalLateMinutes: totalLate,
          entries: (clockRows || []).map((c) => ({
            id: c.id,
            date: c.date,
            clockIn: c.clock_in,
            clockOut: c.clock_out,
            hours: c.hours,
            status: c.status,
            lateMinutes: c.late_minutes || 0,
            overtimeHours: c.overtime_hours || 0,
            attendanceStatus: c.attendance_status,
          })),
        },
        kpis,
        timeline: timeline.slice(0, 200), // cap for perf
      });
    }
  }

  // ── Breaks ────────────────────────────────────────────────────────────
  if (pathname === '/api/timeclock/break-start' && m === 'POST') return breakStart(request, env, auth);
  if (pathname === '/api/timeclock/break-end' && m === 'POST') return breakEnd(request, env, auth);

  // ── Tasks ────────────────────────────────────────────────────────────
  if (pathname.startsWith('/api/tasks')) {
    const sub = pathname.replace(/^\/api\/tasks/, '');
    if (m === 'GET' && (sub === '' || sub === '/')) return listTasks(env, url, auth);
    if (m === 'POST' && (sub === '' || sub === '/')) return createTask(request, env, auth);
    const taskMatch = sub.match(/^\/([^/]+)$/);
    if (m === 'PUT' && taskMatch) return updateTask(request, env, auth, taskMatch[1]);
    if (m === 'DELETE' && taskMatch) return deleteTask(env, auth, taskMatch[1]);
    const completeMatch = sub.match(/^\/([^/]+)\/complete$/);
    if (m === 'POST' && completeMatch) return completeTask(request, env, auth, completeMatch[1]);
  }

  // ── Shift handovers ──────────────────────────────────────────────────
  if (pathname.startsWith('/api/handovers')) {
    const sub = pathname.replace(/^\/api\/handovers/, '');
    if (m === 'GET' && (sub === '' || sub === '/')) return listHandovers(env, url, auth);
    if (m === 'POST' && (sub === '' || sub === '/')) return createHandover(request, env, auth);
    const latestMatch = sub.match(/^\/latest$/);
    if (m === 'GET' && latestMatch) return latestHandover(env, auth);
  }

  return null;
}

// ════════════════════════════════════════════════════════════════════════
// BREAKS
// ════════════════════════════════════════════════════════════════════════

/** POST /api/timeclock/break-start — start a break during the current shift. */
async function breakStart(request, env, auth) {
  const staffId = subjectStaffId({}, auth);
  if (!staffId) return json({ ok: false, error: 'No staff record on this session' }, 400);

  const entry = await openEntryFor(env, staffId);
  if (!entry) return json({ ok: false, error: 'Not clocked in.' }, 409);

  // Refuse if a break is already in progress
  const { results: openBreaks } = await d1Query(
    env,
    'SELECT id FROM break_records WHERE timeclock_id = ? AND end_at IS NULL',
    [entry.id]
  );
  if (openBreaks && openBreaks.length) {
    return json({ ok: false, error: 'Already on break.' }, 409);
  }

  const id = 'BR' + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  const now = new Date().toISOString();
  await d1Run(
    env,
    'INSERT INTO break_records (id, timeclock_id, staff_id, start_at, created) VALUES (?, ?, ?, ?, ?)',
    [id, entry.id, staffId, now, now]
  );

  await writeAudit(env, auth, {
    action: 'create', entity: 'break', entityId: id,
    after: { timeclock_id: entry.id, start_at: now },
  });

  return json({ ok: true, id, staffId, timeclockId: entry.id, startAt: now });
}

/** POST /api/timeclock/break-end — end the current break. */
async function breakEnd(request, env, auth) {
  const staffId = subjectStaffId({}, auth);
  if (!staffId) return json({ ok: false, error: 'No staff record on this session' }, 400);

  const entry = await openEntryFor(env, staffId);
  if (!entry) return json({ ok: false, error: 'Not clocked in.' }, 409);

  const { results } = await d1Query(
    env,
    'SELECT * FROM break_records WHERE timeclock_id = ? AND end_at IS NULL ORDER BY start_at DESC LIMIT 1',
    [entry.id]
  );
  const br = (results || [])[0];
  if (!br) return json({ ok: false, error: 'No break in progress.' }, 409);

  const now = new Date().toISOString();
  const durationMin = Math.round((Date.parse(now) - Date.parse(br.start_at)) / 60000);
  await d1Run(
    env,
    'UPDATE break_records SET end_at = ?, duration_min = ? WHERE id = ?',
    [now, durationMin, br.id]
  );

  await writeAudit(env, auth, {
    action: 'update', entity: 'break', entityId: br.id,
    before: { end_at: null },
    after: { end_at: now, duration_min: durationMin },
  });

  return json({ ok: true, id: br.id, endAt: now, durationMin });
}

// ════════════════════════════════════════════════════════════════════════
// TASKS
// ════════════════════════════════════════════════════════════════════════

/** GET /api/tasks?status=&staff_id= */
async function listTasks(env, url, auth) {
  const sp = url.searchParams;
  const status = sp.get('status');
  const staffId = sp.get('staff_id') || sp.get('staffId');
  const role = String((auth && (auth.sessionRole || auth.role)) || '').toLowerCase();
  const isMgr = isManager(role);

  const clauses = [];
  const params = [];
  // Non-managers only see their own tasks
  if (!isMgr) {
    clauses.push('staff_id = ?');
    params.push(String(auth.staff_id));
  } else if (staffId) {
    clauses.push('staff_id = ?');
    params.push(String(staffId));
  }
  if (status) { clauses.push('status = ?'); params.push(status); }

  const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
  const { results } = await d1Query(
    env,
    `SELECT t.*, s.firstName, s.lastName
       FROM employee_tasks t LEFT JOIN staff s ON s.id = t.staff_id${where}
      ORDER BY t.created DESC LIMIT 200`,
    params
  );
  const rows = (results || []).map((r) => ({
    ...r,
    staffName: [r.firstName, r.lastName].filter(Boolean).join(' ') || null,
  }));
  return json(rows);
}

/** POST /api/tasks — manager creates a task. */
async function createTask(request, env, auth) {
  if (!isManager((auth && (auth.sessionRole || auth.role)) || '')) {
    return json({ ok: false, error: 'Only a manager can create tasks' }, 403);
  }
  const data = await readBody(request);
  if (!data) return json({ ok: false, error: 'Invalid JSON body' }, 400);
  if (!data.staffId || !data.title) {
    return json({ ok: false, error: 'staffId and title are required' }, 400);
  }

  const id = 'TASK' + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  const now = new Date().toISOString();
  await d1Run(
    env,
    `INSERT INTO employee_tasks (id, staff_id, created_by, title, description, priority, due_at, area, status, created, updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [id, String(data.staffId), auth.staff_id, String(data.title), data.description || null,
     data.priority || 'normal', data.dueAt || null, data.area || null, now, now]
  );

  await writeAudit(env, auth, {
    action: 'create', entity: 'task', entityId: id,
    after: { staff_id: data.staffId, title: data.title, priority: data.priority || 'normal' },
  });

  return json({ ok: true, id });
}

/** PUT /api/tasks/:id — update a task (manager or assigned employee). */
async function updateTask(request, env, auth, taskId) {
  const data = await readBody(request);
  if (!data) return json({ ok: false, error: 'Invalid JSON body' }, 400);

  const { results } = await d1Query(env, 'SELECT * FROM employee_tasks WHERE id = ?', [String(taskId)]);
  const task = (results || [])[0];
  if (!task) return json({ ok: false, error: 'Task not found' }, 404);

  const role = String((auth && (auth.sessionRole || auth.role)) || '').toLowerCase();
  const isMgr = isManager(role);
  const isAssigned = auth.staff_id === task.staff_id;
  if (!isMgr && !isAssigned) {
    return json({ ok: false, error: 'Not permitted' }, 403);
  }

  const fields = [];
  const values = [];
  if (data.status !== undefined && ['pending', 'in_progress', 'completed', 'failed', 'cancelled'].includes(data.status)) {
    fields.push('status = ?');
    values.push(data.status);
    if (data.status === 'completed') {
      fields.push('completed_at = ?');
      values.push(new Date().toISOString());
    }
  }
  if (data.note !== undefined) { fields.push('note = ?'); values.push(data.note); }
  if (isMgr && data.priority !== undefined) { fields.push('priority = ?'); values.push(data.priority); }
  if (isMgr && data.dueAt !== undefined) { fields.push('due_at = ?'); values.push(data.dueAt); }
  if (isMgr && data.title !== undefined) { fields.push('title = ?'); values.push(data.title); }
  if (isMgr && data.description !== undefined) { fields.push('description = ?'); values.push(data.description); }

  if (!fields.length) return json({ ok: false, error: 'No fields to update' }, 400);
  fields.push('updated = ?');
  values.push(new Date().toISOString());
  values.push(String(taskId));

  await d1Run(env, `UPDATE employee_tasks SET ${fields.join(', ')} WHERE id = ?`, values);

  await writeAudit(env, auth, {
    action: 'update', entity: 'task', entityId: taskId,
    before: { status: task.status },
    after: data,
  });

  return json({ ok: true });
}

/** POST /api/tasks/:id/complete — employee marks a task complete. */
async function completeTask(request, env, auth, taskId) {
  const data = await readBody(request) || {};
  const { results } = await d1Query(env, 'SELECT * FROM employee_tasks WHERE id = ?', [String(taskId)]);
  const task = (results || [])[0];
  if (!task) return json({ ok: false, error: 'Task not found' }, 404);

  const role = String((auth && (auth.sessionRole || auth.role)) || '').toLowerCase();
  const isMgr = isManager(role);
  const isAssigned = auth.staff_id === task.staff_id;
  if (!isMgr && !isAssigned) {
    return json({ ok: false, error: 'Not permitted' }, 403);
  }
  if (task.status === 'completed') return json({ ok: false, error: 'Already completed' }, 409);

  const now = new Date().toISOString();
  await d1Run(
    env,
    'UPDATE employee_tasks SET status = ?, completed_at = ?, note = ?, updated = ? WHERE id = ?',
    ['completed', now, data.note || null, now, String(taskId)]
  );

  await writeAudit(env, auth, {
    action: 'update', entity: 'task', entityId: taskId,
    before: { status: task.status },
    after: { status: 'completed', completed_at: now },
  });

  return json({ ok: true, completedAt: now });
}

/** DELETE /api/tasks/:id — manager only. */
async function deleteTask(env, auth, taskId) {
  if (!isManager((auth && (auth.sessionRole || auth.role)) || '')) {
    return json({ ok: false, error: 'Only a manager can delete tasks' }, 403);
  }
  await d1Run(env, 'DELETE FROM employee_tasks WHERE id = ?', [String(taskId)]);
  await writeAudit(env, auth, { action: 'delete', entity: 'task', entityId: taskId });
  return json({ ok: true });
}

// ════════════════════════════════════════════════════════════════════════
// SHIFT HANDOVERS
// ════════════════════════════════════════════════════════════════════════

/** GET /api/handovers?staff_id= — list handovers (manager sees all, others see own). */
async function listHandovers(env, url, auth) {
  const sp = url.searchParams;
  const staffId = sp.get('staff_id') || sp.get('staffId');
  const role = String((auth && (auth.sessionRole || auth.role)) || '').toLowerCase();
  const isMgr = isManager(role);

  const clauses = [];
  const params = [];
  if (!isMgr) { clauses.push('staff_id = ?'); params.push(String(auth.staff_id)); }
  else if (staffId) { clauses.push('staff_id = ?'); params.push(String(staffId)); }

  const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
  const { results } = await d1Query(
    env,
    `SELECT h.*, s.firstName, s.lastName
       FROM shift_handovers h LEFT JOIN staff s ON s.id = h.staff_id${where}
      ORDER BY h.created DESC LIMIT 50`,
    params
  );
  const rows = (results || []).map((r) => ({
    ...r,
    staffName: [r.firstName, r.lastName].filter(Boolean).join(' ') || null,
  }));
  return json(rows);
}

/** GET /api/handovers/latest — the most recent handover (for the next shift to read). */
async function latestHandover(env, auth) {
  const { results } = await d1Query(
    env,
    `SELECT h.*, s.firstName, s.lastName
       FROM shift_handovers h LEFT JOIN staff s ON s.id = h.staff_id
      ORDER BY h.created DESC LIMIT 1`
  );
  const row = (results || [])[0];
  if (!row) return json({ ok: true, handover: null });
  return json({
    ok: true,
    handover: {
      ...row,
      staffName: [row.firstName, row.lastName].filter(Boolean).join(' ') || null,
    },
  });
}

/** POST /api/handovers — create a handover (any signed-in employee). */
async function createHandover(request, env, auth) {
  const data = await readBody(request);
  if (!data) return json({ ok: false, error: 'Invalid JSON body' }, 400);

  const staffId = subjectStaffId({}, auth);
  if (!staffId) return json({ ok: false, error: 'No staff record on this session' }, 400);

  const id = 'HO' + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  const now = new Date().toISOString();

  // Link to the current open timeclock entry if one exists
  const entry = await openEntryFor(env, staffId);
  const timeclockId = entry ? entry.id : null;

  await d1Run(
    env,
    `INSERT INTO shift_handovers (id, staff_id, timeclock_id, pending_orders, pending_tasks, cash_info, problems, customer_issues, inventory_notes, important_notes, created)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, staffId, timeclockId,
     data.pendingOrders || null, data.pendingTasks || null, data.cashInfo || null,
     data.problems || null, data.customerIssues || null, data.inventoryNotes || null,
     data.importantNotes || null, now]
  );

  await writeAudit(env, auth, {
    action: 'create', entity: 'handover', entityId: id,
    after: { staff_id: staffId, timeclock_id: timeclockId },
  });

  return json({ ok: true, id });
}
