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

export async function handleHR(pathname, method, url, request, env, auth) {
  const m = method.toUpperCase();

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

  return null;
}
