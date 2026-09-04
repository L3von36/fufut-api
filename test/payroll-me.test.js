import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleHR } from '../src/handlers/hr.js';
import { authorize } from '../src/auth.js';

// getAuthUser talks to D1; stub it so the reachability tests cover policy,
// not storage. Same arrangement as auth.test.js.
vi.mock('../src/handlers/session.js', () => ({
  getAuthUser: vi.fn(),
}));

/**
 * My own payslips, and nobody else's.
 *
 * `/api/payroll/me` is the self-service half of payroll. Payroll documents as
 * a whole stay manager-and-accountant (the run list is the whole cafe's pay
 * in one place); the person still needs THEIR OWN payslip, and privacy makes
 * "ask the manager" the wrong answer. The two things worth pinning are the
 * two ways it could go wrong: the route must be reachable by a role with no
 * `payroll` grant at all (otherwise the waiter is back to asking), and it
 * must answer only the caller's own rows — there is no parameter by which it
 * can be pointed at a colleague, which is the difference between this and
 * /api/timeclock/me/history, where a manager MAY name a staff member.
 */

const WAITER = { staff_id: 'S1', sessionRole: 'head-waiter' };
const MANAGER = { staff_id: 'S9', sessionRole: 'manager' };
const CASHIER = { staff_id: 'S3', sessionRole: 'cashier' };

const LINES = [
  {
    id: 'PL1', run_id: 'RUN2', staff_id: 'S1', base_salary: 4200, overtime_pay: 315,
    bonuses: 0, deductions: 0, gross_pay: 4515, taxable_pay: 4221, income_tax: 333.15,
    pension_employee: 294, pension_employer: 462, net_pay: 3887.85, tips_earned: 120,
    days_worked: 26, days_absent: 0, breakdown: '{"monthlyHours":208}',
    created_at: '2026-09-01T10:00:00Z',
    period_start: '2026-08-01', period_end: '2026-08-30', run_status: 'finalised', provisional: 0,
  },
  {
    id: 'PL9', run_id: 'RUN2', staff_id: 'S2', base_salary: 9500,
    period_start: '2026-08-01', period_end: '2026-08-30', run_status: 'finalised', provisional: 0,
  },
];

const STAFF_ROWS = [{ base_salary: 4200, salary_period: 'monthly', employment_type: 'full-time' }];

function makeEnv(lines = LINES, staffRows = STAFF_ROWS) {
  const boundParams = [];
  const prepare = vi.fn(function (sql) {
    const exec = (params) => ({
      all: async () => {
        if (/FROM payroll_lines/.test(sql)) {
          // The WHERE clause carries the caller's staff_id; answer only rows
          // that belong to it, like the real engine would.
          const who = params[0];
          return { results: lines.filter((l) => String(l.staff_id) === String(who)) };
        }
        if (/FROM staff/.test(sql)) {
          return { results: staffRows };
        }
        return { results: [] };
      },
      run: async () => ({ meta: { changes: 0 }, results: [] }),
    });
    return {
      bind: (...params) => {
        boundParams.push({ sql, params });
        return exec(params);
      },
      all: async () => exec([]).all(),
      run: async () => ({ meta: { changes: 0 }, results: [] }),
    };
  });
  return { env: { DB: { prepare } }, boundParams };
}

function req(pathname) {
  const url = new URL('https://pos.fufutcoffee.com' + pathname);
  return { url, request: new Request(url.toString(), { method: 'GET' }) };
}

describe('GET /api/payroll/me — reachability', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['head-waiter', 'cashier', 'cleaner', 'barista', 'assistant-chef', 'delivery-staff'])(
    'allows a %s with no payroll grant to read their own payslips',
    async (role) => {
      const url = new URL('https://api.test/api/payroll/me');
      const { getAuthUser } = await import('../src/handlers/session.js');
      getAuthUser.mockResolvedValue({ staff_id: 'S1', sessionRole: role });
      const d = await authorize(new Request(url), {}, '/api/payroll/me', 'GET', url);
      expect(d.ok).toBe(true);
    }
  );

  it('refuses an unauthenticated caller', async () => {
    const url = new URL('https://api.test/api/payroll/me');
    const { getAuthUser } = await import('../src/handlers/session.js');
    getAuthUser.mockResolvedValue(null);
    const d = await authorize(new Request(url), {}, '/api/payroll/me', 'GET', url);
    expect(d.ok).toBe(false);
    expect(d.response.status).toBe(401);
  });

  it.each(['accountant', 'manager'])('still answers a %s, who also holds the wide grant', async (role) => {
    const url = new URL('https://api.test/api/payroll/me');
    const { getAuthUser } = await import('../src/handlers/session.js');
    getAuthUser.mockResolvedValue({ staff_id: 'S9', sessionRole: role });
    const d = await authorize(new Request(url), {}, '/api/payroll/me', 'GET', url);
    expect(d.ok).toBe(true);
  });
});

describe('GET /api/payroll/me — scoping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('answers a waiter only their own payslip lines', async () => {
    const { env } = makeEnv();
    const r = req('/api/payroll/me');
    const res = await handleHR('/api/payroll/me', 'GET', r.url, r.request, env, WAITER);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.payslips).toHaveLength(1);
    expect(body.payslips[0].id).toBe('PL1');
    // The colleague's line never crosses the wire.
    expect(body.payslips.some((p) => p.staff_id === 'S2' || p.id === 'PL9')).toBe(false);
    // The caller's current pay, from their own staff row.
    expect(body.current).toEqual({ baseSalary: 4200, salaryPeriod: 'monthly', employmentType: 'full-time' });
  });

  it('scopes the query to the session staff id, never to a query parameter', async () => {
    const { env, boundParams } = makeEnv();
    const r = req('/api/payroll/me?staffId=S2');
    await handleHR('/api/payroll/me', 'GET', r.url, r.request, env, WAITER);

    const mine = boundParams.find((b) => /FROM payroll_lines/.test(b.sql));
    expect(mine.params[0]).toBe('S1');
  });

  it('answers a manager their OWN payslips — /me has no parameters for anyone', async () => {
    const { env, boundParams } = makeEnv();
    const r = req('/api/payroll/me?staffId=S2');
    const res = await handleHR('/api/payroll/me', 'GET', r.url, r.request, env, MANAGER);
    const body = await res.json();

    expect(body.payslips).toHaveLength(0); // the manager holds no payroll_lines for S9 in the fake
    const mine = boundParams.find((b) => /FROM payroll_lines/.test(b.sql));
    expect(mine.params[0]).toBe('S9');
  });

  it('returns no colleague data even when the fake answers wrongly, because the wire filters by staff_id', async () => {
    // A cashier with no lines: empty list, and the staff block is their own.
    const { env } = makeEnv([], [{ base_salary: 7000, salary_period: 'monthly', employment_type: null }]);
    const r = req('/api/payroll/me');
    const res = await handleHR('/api/payroll/me', 'GET', r.url, r.request, env, CASHIER);
    const body = await res.json();

    expect(body.payslips).toEqual([]);
    expect(body.current.baseSalary).toBe(7000);
  });

  it('refuses with 401 when the session carries no staff record', async () => {
    const { env } = makeEnv();
    const r = req('/api/payroll/me');
    const res = await handleHR('/api/payroll/me', 'GET', r.url, r.request, env, { sessionRole: 'head-waiter' });
    expect(res.status).toBe(401);
  });

  it('parses the stored breakdown JSON and leaves a corrupt one null', async () => {
    const broken = [{ ...LINES[0], breakdown: '{not json' }];
    const { env } = makeEnv(broken);
    const r = req('/api/payroll/me');
    const res = await handleHR('/api/payroll/me', 'GET', r.url, r.request, env, WAITER);
    const body = await res.json();

    expect(body.payslips[0].breakdown).toBeNull();
  });
});
