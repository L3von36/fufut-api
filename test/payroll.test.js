import { describe, it, expect } from 'vitest';
import {
  classifyAttendance,
  hourlyRate,
  overtimeAmount,
  incomeTax,
  payrollLine,
  settingsFromRows,
  isOnLeave,
  minutesBetween,
} from '../src/lib/payroll.js';

/** The seeded settings, as settingsFromRows would produce them. */
const SETTINGS = {
  overtimeMultipliers: { normal: 1.5, night: 1.75, rest_day: 2.0, public_holiday: 2.5 },
  monthlyHours: 208,
  pension: { employee: 0.07, employer: 0.11 },
  incomeBands: [
    { upTo: 600, rate: 0, deduct: 0 },
    { upTo: 1650, rate: 0.10, deduct: 60 },
    { upTo: 3200, rate: 0.15, deduct: 142.5 },
    { upTo: 5250, rate: 0.20, deduct: 302.5 },
    { upTo: 7800, rate: 0.25, deduct: 565 },
    { upTo: 10900, rate: 0.30, deduct: 955 },
    { upTo: null, rate: 0.35, deduct: 1500 },
  ],
  lateGraceMinutes: 10,
  standardDayHours: 8,
};

const STAFF = { id: 'S1', firstName: 'Selam', lastName: 'Wondimu', base_salary: 8000 };

describe('minutesBetween', () => {
  it('reads HH:MM and ISO timestamps alike', () => {
    expect(minutesBetween('09:00', '09:15')).toBe(15);
    expect(minutesBetween('2026-08-10T09:00:00Z', '2026-08-10T09:30:00Z')).toBe(30);
  });

  it('returns null rather than zero when a time is missing', () => {
    // Zero would read as "on time", which is a different claim from "unknown".
    expect(minutesBetween(null, '09:15')).toBeNull();
    expect(minutesBetween('09:00', '')).toBeNull();
  });
});

describe('attendance classification', () => {
  it('marks an on-time arrival present', () => {
    const r = classifyAttendance(
      { clockIn: '09:00', clockOut: '17:00', scheduledStart: '09:00', scheduledEnd: '17:00' },
      SETTINGS
    );
    expect(r.status).toBe('present');
    expect(r.lateMinutes).toBe(0);
    expect(r.hoursWorked).toBe(8);
  });

  /**
   * Grace exists so the system is obeyed rather than ignored. Marking somebody
   * late for three minutes is how attendance data stops being taken seriously.
   */
  it('does not mark somebody late inside the grace period', () => {
    const r = classifyAttendance(
      { clockIn: '09:08', scheduledStart: '09:00', clockOut: '17:00', scheduledEnd: '17:00' },
      SETTINGS
    );
    expect(r.status).toBe('present');
    expect(r.lateMinutes).toBe(0);
  });

  it('marks lateness beyond the grace period, and by how much', () => {
    const r = classifyAttendance(
      { clockIn: '09:25', scheduledStart: '09:00', clockOut: '17:00', scheduledEnd: '17:00' },
      SETTINGS
    );
    expect(r.status).toBe('late');
    expect(r.lateMinutes).toBe(25);
  });

  it('detects an early departure', () => {
    const r = classifyAttendance(
      { clockIn: '09:00', scheduledStart: '09:00', clockOut: '16:00', scheduledEnd: '17:00' },
      SETTINGS
    );
    expect(r.status).toBe('early-departure');
    expect(r.earlyLeaveMinutes).toBe(60);
  });

  it('counts hours past the standard day as overtime', () => {
    const r = classifyAttendance(
      { clockIn: '09:00', clockOut: '20:00', scheduledStart: '09:00', scheduledEnd: '17:00' },
      SETTINGS
    );
    expect(r.hoursWorked).toBe(11);
    expect(r.overtimeHours).toBe(3);
  });

  it('handles a shift that crosses midnight', () => {
    // 20:00 → 04:00 is eight hours, not minus sixteen.
    const r = classifyAttendance({ clockIn: '20:00', clockOut: '04:00' }, SETTINGS);
    expect(r.hoursWorked).toBe(8);
  });

  it('is absent only when there is no clock-in at all', () => {
    expect(classifyAttendance({}, SETTINGS).status).toBe('absent');
  });

  /**
   * A missing clock-out almost always means somebody forgot. Inferring a
   * departure time would put an invented number straight into payroll.
   */
  it('does not invent a departure time when the clock-out is missing', () => {
    const r = classifyAttendance({ clockIn: '09:00', scheduledStart: '09:00' }, SETTINGS);
    expect(r.status).toBe('present');
    expect(r.hoursWorked).toBe(0);
    expect(r.overtimeHours).toBe(0);
  });

  it('reports approved leave as leave, not absence', () => {
    const r = classifyAttendance({ onLeave: true }, SETTINGS);
    expect(r.status).toBe('on-leave');
  });
});

describe('overtime', () => {
  it('derives an hourly rate from salary and contracted hours', () => {
    expect(hourlyRate(8000, SETTINGS)).toBeCloseTo(38.46, 2);
  });

  it('applies the multiplier for the kind of overtime worked', () => {
    const normal = overtimeAmount(4, 8000, 'normal', SETTINGS);
    const holiday = overtimeAmount(4, 8000, 'public_holiday', SETTINGS);
    expect(normal.multiplier).toBe(1.5);
    expect(holiday.multiplier).toBe(2.5);
    expect(holiday.amount).toBeGreaterThan(normal.amount);
    expect(normal.amount).toBeCloseTo(230.77, 1);
  });

  it('falls back to the normal multiplier for an unrecognised kind', () => {
    expect(overtimeAmount(1, 8000, 'nonsense', SETTINGS).multiplier).toBe(1.5);
  });

  it('returns the multiplier so it can be stored against the claim', () => {
    // A settings change later must not alter what somebody was already paid.
    expect(overtimeAmount(2, 8000, 'night', SETTINGS)).toHaveProperty('multiplier', 1.75);
  });
});

describe('income tax', () => {
  it('exempts pay inside the zero band', () => {
    expect(incomeTax(500, SETTINGS.incomeBands)).toBe(0);
  });

  it('applies the band the pay falls into', () => {
    // 1,500 → 10% − 60 = 90
    expect(incomeTax(1500, SETTINGS.incomeBands)).toBe(90);
    // 4,000 → 20% − 302.5 = 497.5
    expect(incomeTax(4000, SETTINGS.incomeBands)).toBe(497.5);
  });

  it('uses the top band above the last ceiling', () => {
    // 20,000 → 35% − 1,500 = 5,500
    expect(incomeTax(20000, SETTINGS.incomeBands)).toBe(5500);
  });

  it('never produces a negative deduction', () => {
    expect(incomeTax(601, SETTINGS.incomeBands)).toBeGreaterThanOrEqual(0);
  });

  /**
   * No configured bands means "we have not been told what the rate is".
   * Inventing a deduction from somebody's wages is the worst possible default.
   */
  it('deducts nothing when no bands are configured', () => {
    expect(incomeTax(8000, [])).toBe(0);
    expect(incomeTax(8000, undefined)).toBe(0);
  });
});

describe('payroll line', () => {
  it('computes pension on basic salary and taxes what is left', () => {
    const line = payrollLine({ staff: STAFF, settings: SETTINGS });
    expect(line.grossPay).toBe(8000);
    expect(line.pensionEmployee).toBe(560);    // 7% of 8,000
    expect(line.pensionEmployer).toBe(880);    // 11%, employer's cost
    expect(line.taxablePay).toBe(7440);        // pension is pre-tax
    expect(line.incomeTax).toBe(1295);         // 25% of 7,440 − 565
    expect(line.netPay).toBe(6145);            // 8,000 − 1,295 − 560
  });

  it('adds approved overtime into gross', () => {
    const line = payrollLine({
      staff: STAFF,
      overtimeEntries: [{ hours: 4, kind: 'normal', amount: 230.77 }],
      settings: SETTINGS,
    });
    expect(line.overtimePay).toBe(230.77);
    expect(line.grossPay).toBe(8230.77);
  });

  it('trusts a stored overtime amount over recomputing it', () => {
    // It was computed at the multiplier in force when it was approved.
    const line = payrollLine({
      staff: STAFF,
      overtimeEntries: [{ hours: 4, kind: 'normal', amount: 999 }],
      settings: SETTINGS,
    });
    expect(line.overtimePay).toBe(999);
  });

  it('separates a taxable bonus from a non-taxable reimbursement', () => {
    const taxed = payrollLine({
      staff: STAFF,
      adjustments: [{ amount: 1000, taxable: 1 }],
      settings: SETTINGS,
    });
    const untaxed = payrollLine({
      staff: STAFF,
      adjustments: [{ amount: 1000, taxable: 0 }],
      settings: SETTINGS,
    });
    expect(taxed.grossPay).toBe(9000);
    expect(untaxed.grossPay).toBe(8000);
    // A reimbursement still reaches the person's pocket.
    expect(untaxed.netPay).toBe(taxed.netPay + taxed.incomeTax - untaxed.incomeTax);
  });

  it('subtracts a deduction without taxing it away first', () => {
    const line = payrollLine({
      staff: STAFF,
      adjustments: [{ amount: -500, reason: 'Salary advance' }],
      settings: SETTINGS,
    });
    expect(line.deductions).toBe(500);
    expect(line.grossPay).toBe(8000);
    expect(line.netPay).toBe(5645);
  });

  /**
   * The rule the whole module exists to protect. A tip is the guest's money
   * given to a person; it is not revenue, not payroll, and taxing it here would
   * be taking a cut of something that was never the restaurant's.
   */
  it('reports tips without putting them in gross, tax or net', () => {
    const withTips = payrollLine({ staff: STAFF, tips: 2500, settings: SETTINGS });
    const without = payrollLine({ staff: STAFF, tips: 0, settings: SETTINGS });

    expect(withTips.tipsEarned).toBe(2500);
    expect(withTips.grossPay).toBe(without.grossPay);
    expect(withTips.incomeTax).toBe(without.incomeTax);
    expect(withTips.netPay).toBe(without.netPay);
  });

  it('records which rates it used, so a payslip stays explicable', () => {
    const line = payrollLine({ staff: STAFF, settings: SETTINGS });
    expect(line.breakdown.monthlyHours).toBe(208);
    expect(line.breakdown.bandsApplied).toBe(7);
  });
});

describe('settings parsing', () => {
  it('parses JSON values and leaves plain strings alone', () => {
    const s = settingsFromRows([
      { key: 'payroll.monthly_hours', value: '208' },
      { key: 'payroll.pension', value: '{"employee":0.07,"employer":0.11}' },
      { key: 'tax.income_bands', value: '[{"upTo":600,"rate":0,"deduct":0}]' },
    ]);
    expect(s.monthlyHours).toBe(208);
    expect(s.pension.employee).toBe(0.07);
    expect(s.incomeBands).toHaveLength(1);
  });

  it('survives one malformed row rather than taking payroll offline', () => {
    const s = settingsFromRows([
      { key: 'tax.income_bands', value: '{not json' },
      { key: 'payroll.monthly_hours', value: '160' },
    ]);
    expect(s.monthlyHours).toBe(160);
  });

  it('flags rates that nobody has confirmed yet', () => {
    // Payroll output is presented as provisional until an accountant signs off.
    expect(settingsFromRows([{ key: 'payroll._unverified', value: 'true' }]).unverified).toBe(true);
  });

  it('falls back to sane defaults when a key is absent', () => {
    const s = settingsFromRows([]);
    expect(s.monthlyHours).toBe(208);
    expect(s.lateGraceMinutes).toBe(10);
    expect(s.incomeBands).toEqual([]);
  });
});

describe('leave overlap', () => {
  const leave = [{ status: 'approved', start_date: '2026-08-10', end_date: '2026-08-14' }];

  it('covers the first and last day inclusively', () => {
    expect(isOnLeave('2026-08-10', leave)).toBe(true);
    expect(isOnLeave('2026-08-14', leave)).toBe(true);
    expect(isOnLeave('2026-08-15', leave)).toBe(false);
  });

  it('ignores a request that has not been approved', () => {
    expect(isOnLeave('2026-08-11', [{ ...leave[0], status: 'pending' }])).toBe(false);
  });
});
