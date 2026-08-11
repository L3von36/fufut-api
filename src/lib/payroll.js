/**
 * Attendance and payroll arithmetic.
 *
 * Pure functions over plain rows and a settings object. Nothing here knows a
 * tax rate, an overtime multiplier or a grace period — every one of those is
 * passed in from the `settings` table, because §46 of the spec is explicit that
 * legal and fiscal rules must not be hard-coded, and because a rate baked into
 * a release is a rate that stays wrong until somebody redeploys.
 *
 * ── The rule that matters most ──────────────────────────────────────────────
 *
 * **A tip is never payroll.** It is money a guest gave to a person; it is not
 * the restaurant's to pay out, not part of gross, and not taxed as employment
 * income by this system. `payrollLine()` reports `tipsEarned` alongside the
 * payslip so the person can see what they are owed, and deliberately excludes
 * it from every total. The same separation exists in the payments layer, for
 * the same reason.
 */

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function round2(n) {
  return Math.round(num(n) * 100) / 100;
}

/** Minutes between two HH:MM or ISO times. Negative if `b` is before `a`. */
export function minutesBetween(a, b) {
  const parse = (t) => {
    if (!t) return null;
    const s = String(t);
    // "09:15" or a full ISO timestamp; both appear in timeclock rows.
    const hm = s.match(/^(\d{1,2}):(\d{2})/);
    if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.getHours() * 60 + d.getMinutes();
  };
  const ma = parse(a);
  const mb = parse(b);
  if (ma === null || mb === null) return null;
  return mb - ma;
}

/**
 * Classify one worked day.
 *
 * The grace period is why this is not a comparison: arriving at 09:03 against a
 * 09:00 start is not lateness anybody should be marked for, and a system that
 * says otherwise gets ignored rather than obeyed.
 *
 * Returns `absent` only when there is no clock-in at all. A missing *clock-out*
 * is left as present with no hours, because it usually means somebody forgot,
 * and inferring a departure time would put an invented number into payroll.
 */
export function classifyAttendance(entry, settings = {}) {
  const grace = num(settings.lateGraceMinutes, 10);
  const standardDay = num(settings.standardDayHours, 8);

  if (entry.onLeave) {
    return { status: 'on-leave', lateMinutes: 0, earlyLeaveMinutes: 0, hoursWorked: 0, overtimeHours: 0 };
  }
  if (!entry.clockIn) {
    return { status: 'absent', lateMinutes: 0, earlyLeaveMinutes: 0, hoursWorked: 0, overtimeHours: 0 };
  }

  const lateBy = entry.scheduledStart ? minutesBetween(entry.scheduledStart, entry.clockIn) : null;
  const lateMinutes = lateBy !== null && lateBy > grace ? lateBy : 0;

  const earlyBy = entry.scheduledEnd && entry.clockOut
    ? minutesBetween(entry.clockOut, entry.scheduledEnd)
    : null;
  const earlyLeaveMinutes = earlyBy !== null && earlyBy > grace ? earlyBy : 0;

  let hoursWorked = num(entry.hours);
  if (!hoursWorked && entry.clockOut) {
    const mins = minutesBetween(entry.clockIn, entry.clockOut);
    // A shift crossing midnight reads as negative; add a day rather than
    // recording a negative day's work.
    hoursWorked = mins === null ? 0 : (mins < 0 ? mins + 1440 : mins) / 60;
  }

  const overtimeHours = Math.max(0, hoursWorked - standardDay);

  let status = 'present';
  if (lateMinutes > 0 && earlyLeaveMinutes > 0) status = 'late';
  else if (lateMinutes > 0) status = 'late';
  else if (earlyLeaveMinutes > 0) status = 'early-departure';

  return {
    status,
    lateMinutes,
    earlyLeaveMinutes,
    hoursWorked: Math.round(hoursWorked * 100) / 100,
    overtimeHours: Math.round(overtimeHours * 100) / 100,
  };
}

/**
 * Hourly rate implied by a monthly salary.
 *
 * Contracted hours come from settings; there is no universal figure and
 * assuming one would misstate every overtime payment.
 */
export function hourlyRate(baseSalary, settings = {}) {
  const hours = num(settings.monthlyHours, 208);
  if (hours <= 0) return 0;
  return num(baseSalary) / hours;
}

/**
 * Value one overtime claim.
 *
 * The multiplier is returned as well as the amount so it can be stored on the
 * row. A settings change afterwards must not alter what somebody was already
 * paid, which is the same snapshot rule the recipe engine follows.
 */
export function overtimeAmount(hours, baseSalary, kind, settings = {}) {
  const multipliers = settings.overtimeMultipliers || {};
  const multiplier = num(multipliers[kind], num(multipliers.normal, 1.5));
  const rate = hourlyRate(baseSalary, settings);
  return {
    hours: round2(hours),
    kind,
    multiplier,
    hourlyRate: round2(rate),
    amount: round2(num(hours) * rate * multiplier),
  };
}

/**
 * Progressive income tax.
 *
 * Bands are `{upTo, rate, deduct}` evaluated in order, with `upTo: null` as the
 * top band. The `deduct` form is how Ethiopian PAYE tables are published, so
 * the settings row can be copied from the published table and checked against
 * it directly rather than being reverse-engineered into marginal arithmetic.
 *
 * Returns 0 with no bands configured rather than guessing a rate — an unset
 * table means "we have not been told", and inventing a deduction from somebody's
 * wages is the worst possible default.
 */
export function incomeTax(taxablePay, bands) {
  const pay = num(taxablePay);
  if (pay <= 0 || !Array.isArray(bands) || !bands.length) return 0;

  for (const band of bands) {
    const ceiling = band.upTo === null || band.upTo === undefined ? Infinity : num(band.upTo);
    if (pay <= ceiling) {
      return Math.max(0, round2(pay * num(band.rate) - num(band.deduct)));
    }
  }
  const top = bands[bands.length - 1];
  return Math.max(0, round2(pay * num(top.rate) - num(top.deduct)));
}

/**
 * Build one payslip line.
 *
 * Order of operations, which is where payroll usually goes wrong:
 *   1. gross      = base + overtime + taxable bonuses
 *   2. pension    = employee share of *basic salary*, not of gross
 *   3. taxable    = gross − employee pension  (pension is pre-tax)
 *   4. income tax = progressive bands on taxable
 *   5. net        = gross − tax − pension − non-taxable deductions
 *
 * Tips are attached for information and are in none of those steps.
 */
export function payrollLine({
  staff,
  overtimeEntries = [],
  adjustments = [],
  tips = 0,
  daysWorked = 0,
  daysAbsent = 0,
  settings = {},
}) {
  const base = num(staff.base_salary);

  const overtimePay = round2(
    overtimeEntries.reduce((sum, o) => {
      // A stored amount is authoritative: it was computed at the multiplier in
      // force when the overtime was approved.
      if (o.amount != null) return sum + num(o.amount);
      return sum + overtimeAmount(o.hours, base, o.kind || 'normal', settings).amount;
    }, 0)
  );

  let taxableBonuses = 0;
  let untaxedBonuses = 0;
  let deductions = 0;
  for (const a of adjustments) {
    const amt = num(a.amount);
    if (amt >= 0) {
      if (a.taxable === 0 || a.taxable === false) untaxedBonuses += amt;
      else taxableBonuses += amt;
    } else {
      deductions += Math.abs(amt);
    }
  }

  const gross = round2(base + overtimePay + taxableBonuses);

  const pensionRates = settings.pension || {};
  const pensionEmployee = round2(base * num(pensionRates.employee));
  const pensionEmployer = round2(base * num(pensionRates.employer));

  const taxablePay = round2(Math.max(0, gross - pensionEmployee));
  const tax = incomeTax(taxablePay, settings.incomeBands);

  const net = round2(gross + untaxedBonuses - tax - pensionEmployee - deductions);

  return {
    staffId: staff.id,
    staffName: [staff.firstName, staff.lastName].filter(Boolean).join(' '),
    baseSalary: round2(base),
    overtimePay,
    bonuses: round2(taxableBonuses + untaxedBonuses),
    deductions: round2(deductions),
    grossPay: gross,
    taxablePay,
    incomeTax: tax,
    pensionEmployee,
    pensionEmployer,
    netPay: net,
    // Reported, never added. See the module comment.
    tipsEarned: round2(tips),
    daysWorked: round2(daysWorked),
    daysAbsent: round2(daysAbsent),
    breakdown: {
      monthlyHours: num(settings.monthlyHours, 208),
      overtimeMultipliers: settings.overtimeMultipliers || null,
      pension: pensionRates,
      bandsApplied: Array.isArray(settings.incomeBands) ? settings.incomeBands.length : 0,
    },
  };
}

/**
 * Turn the settings rows into the shape the functions above expect.
 *
 * Values are stored as JSON text so a band table and a single number can share
 * one column; anything unparseable falls back to the raw string rather than
 * throwing, so one malformed row cannot take payroll offline.
 */
export function settingsFromRows(rows) {
  const map = {};
  for (const r of rows || []) {
    let v = r.value;
    try { v = JSON.parse(r.value); } catch { /* keep the raw string */ }
    map[r.key] = v;
  }
  return {
    unverified: map['payroll._unverified'] === true || map['payroll._unverified'] === 'true',
    overtimeMultipliers: map['payroll.overtime_multipliers'] || {},
    monthlyHours: num(map['payroll.monthly_hours'], 208),
    incomeBands: map['tax.income_bands'] || [],
    pension: map['payroll.pension'] || {},
    lateGraceMinutes: num(map['attendance.late_grace_minutes'], 10),
    standardDayHours: num(map['attendance.standard_day_hours'], 8),
    serviceChargePct: num(map['service.charge_pct'], 0),
    vatPct: num(map['service.vat_pct'], 0),
    raw: map,
  };
}

/** Does `date` (YYYY-MM-DD) fall inside an approved leave request? */
export function isOnLeave(date, leaveRows) {
  return (leaveRows || []).some(
    (l) => l.status === 'approved' && date >= l.start_date && date <= l.end_date
  );
}
