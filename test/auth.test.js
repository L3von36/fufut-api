import { describe, it, expect, vi, beforeEach } from 'vitest';
import { authorize, redactStaffForRole } from '../src/auth.js';

// getAuthUser talks to D1; stub it so these tests cover policy, not storage.
vi.mock('../src/handlers/session.js', () => ({
  getAuthUser: vi.fn(),
}));
import { getAuthUser } from '../src/handlers/session.js';

const req = () => new Request('https://api.test/');

async function decide(pathname, method, session = null) {
  getAuthUser.mockResolvedValue(session);
  return authorize(req(), {}, pathname, method);
}

describe('public surface', () => {
  beforeEach(() => vi.clearAllMocks());

  // The public website is served by this same Worker. If any of these start
  // requiring a session, fufutcoffee.com breaks.
  it.each([
    ['GET', '/api/content'],
    ['GET', '/api/menu'],
    ['GET', '/api/menus'],
    ['GET', '/api/reviews'],
    ['GET', '/api/images/uploads/x.png'],
    ['POST', '/api/auth/login'],
  ])('allows %s %s without a session', async (m, p) => {
    const d = await decide(p, m, null);
    expect(d.ok).toBe(true);
  });

  // Anonymous customer actions: online booking, online ordering, reviews.
  it.each([
    ['POST', '/api/reservations'],
    ['POST', '/api/orders'],
    ['POST', '/api/reviews'],
  ])('allows anonymous customers to %s %s', async (m, p) => {
    const d = await decide(p, m, null);
    expect(d.ok).toBe(true);
  });
});

// Regression (four-role smoke, 2026-08-26): PUBLIC was matched before the
// session was resolved, so a signed-in cleaner, accountant or delivery driver
// could POST /api/orders (or a reservation, or a review) with a 200 — writes
// their role does not hold. The anonymous rule now applies only to a caller
// with no session; a session goes through the role matrix like any other
// request.
describe('anonymous writes vs signed-in sessions', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['cleaner', 'accountant', 'delivery-staff'])(
    'refuses a signed-in %s the anonymous order write with 403',
    async (role) => {
      const d = await decide('/api/orders', 'POST', { staff_id: 'S10', sessionRole: role });
      expect(d.ok).toBe(false);
      expect(d.response.status).toBe(403);
    }
  );

  it('refuses a signed-in cleaner the anonymous reservation and review writes', async () => {
    for (const p of ['/api/reservations', '/api/reviews']) {
      const d = await decide(p, 'POST', { staff_id: 'S10', sessionRole: 'cleaner' });
      expect(d.ok).toBe(false);
      expect(d.response.status).toBe(403);
    }
  });

  it('still lets a waiter create an order — the POS fire path must not regress', async () => {
    const d = await decide('/api/orders', 'POST', { staff_id: 'S6', sessionRole: 'head-waiter' });
    expect(d.ok).toBe(true);
  });

  it('still lets a manager create an order and a reservation', async () => {
    for (const p of ['/api/orders', '/api/reservations']) {
      const d = await decide(p, 'POST', { staff_id: 'S1', sessionRole: 'manager' });
      expect(d.ok).toBe(true);
    }
  });

  it('still lets a signed-in staff member sign in again — login is session establishment, not an anonymous write', async () => {
    const d = await decide('/api/auth/login', 'POST', { staff_id: 'S10', sessionRole: 'cleaner' });
    expect(d.ok).toBe(true);
  });

  // A public read stays public even for a signed-in session — unchanged
  // behaviour, pinned so the reordering cannot quietly narrow it.
  it('still serves public reads to a signed-in session', async () => {
    for (const p of ['/api/menu', '/api/content']) {
      const d = await decide(p, 'GET', { staff_id: 'S10', sessionRole: 'cleaner' });
      expect(d.ok).toBe(true);
    }
  });
});

describe('protected surface', () => {
  beforeEach(() => vi.clearAllMocks());

  // Regression: these all answered 200 unauthenticated in production, exposing
  // staff phone numbers, customer PII, orders and revenue.
  it.each([
    'staff', 'orders', 'reservations', 'expenses', 'inventory',
    'tables', 'shifts', 'timeclock', 'waste', 'delivery',
  ])('rejects anonymous GET /api/%s with 401', async (res) => {
    const d = await decide(`/api/${res}`, 'GET', null);
    expect(d.ok).toBe(false);
    expect(d.response.status).toBe(401);
  });

  // Regression: unauthenticated PUT/DELETE reached the handler in production.
  it.each([['PUT', '/api/staff/S8'], ['DELETE', '/api/menu/M1'], ['PUT', '/api/orders/O1']])(
    'rejects anonymous %s %s',
    async (m, p) => {
      const d = await decide(p, m, null);
      expect(d.ok).toBe(false);
      expect(d.response.status).toBe(401);
    }
  );

  it('allows an authenticated staff member through to their own resources', async () => {
    const d = await decide('/api/waste', 'GET', { staff_id: 'S1', sessionRole: 'Cleaner' });
    expect(d.ok).toBe(true);
  });

  // Previously this same call succeeded: a session was all it took, so a
  // cleaner could read every order in the business. Role access is now checked
  // per resource, and orders are not a cleaner's.
  it('refuses an authenticated staff member a resource outside their role', async () => {
    const d = await decide('/api/orders', 'GET', { staff_id: 'S1', sessionRole: 'Cleaner' });
    expect(d.ok).toBe(false);
    expect(d.response.status).toBe(403);
  });

  it('lets any role end its own session, whatever else it may not reach', async () => {
    for (const path of ['/api/auth/me', '/api/auth/logout']) {
      const d = await decide(path, path.endsWith('logout') ? 'POST' : 'GET', {
        staff_id: 'S1',
        sessionRole: 'Cleaner',
      });
      expect(d.ok).toBe(true);
    }
  });

  it('reads SSE as protected', async () => {
    const d = await decide('/api/events/kitchen', 'GET', null);
    expect(d.response.status).toBe(401);
  });
});

// An account carrying a password a manager handed over must be able to do
// exactly one thing: replace it. Enforced here rather than trusted to the
// client, or a stale tab would carry on working on a credential someone else
// knows.
describe('forced password change', () => {
  beforeEach(() => vi.clearAllMocks());

  const pending = { staff_id: 'S2', sessionRole: 'Head Chef', must_change_password: 1 };

  it.each([
    ['GET', '/api/orders'],
    ['GET', '/api/inventory'],
    ['PUT', '/api/orders/O1'],
    ['GET', '/api/staff'],
    // Note: GET /api/menu is deliberately absent - it is public, so it resolves
    // before any session is considered and is not the gate's business.
  ])('refuses %s %s until the password is changed', async (m, p) => {
    const d = await decide(p, m, pending);
    expect(d.ok).toBe(false);
    expect(d.response.status).toBe(403);
  });

  it.each([
    ['POST', '/api/auth/logout'],
    ['GET', '/api/auth/me'],
  ])('still allows %s %s', async (m, p) => {
    const d = await decide(p, m, pending);
    expect(d.ok).toBe(true);
  });

  /**
   * The trap the manager-owns-passwords policy creates, pinned deliberately.
   *
   * change-password is now MANAGER_ONLY, which is checked *before* the
   * must_change_password block. So an ordinary account carrying the flag is
   * refused every route in the system including the only one it used to be
   * allowed — it can log out and check who it is, and nothing else.
   *
   * That is why cfg-004 clears the flag and why staff.js and session.js no
   * longer set it. If this test ever starts failing because the flag is being
   * set again, accounts are being bricked at the moment of creation.
   */
  it('leaves a flagged non-manager with no way to rescue itself', async () => {
    const d = await decide('/api/auth/change-password', 'POST', pending);
    expect(d.ok).toBe(false);
    expect(d.response.status).toBe(403);
  });

  // A manager clears MANAGER_ONLY, so the flag still behaves as it always did
  // for them: one permitted action, and it is the useful one.
  it('still lets a flagged manager change their own password', async () => {
    const d = await decide('/api/auth/change-password', 'POST', {
      staff_id: 'S4', sessionRole: 'Manager', must_change_password: 1,
    });
    expect(d.ok).toBe(true);
  });

  it('applies whatever the role, including a manager', async () => {
    const d = await decide('/api/staff', 'GET', {
      staff_id: 'S4', sessionRole: 'Manager', must_change_password: 1,
    });
    expect(d.ok).toBe(false);
    expect(d.response.status).toBe(403);
  });

  it('lets a settled account through as normal', async () => {
    const d = await decide('/api/orders', 'GET', {
      staff_id: 'S2', sessionRole: 'Head Chef', must_change_password: 0,
    });
    expect(d.ok).toBe(true);
  });
});

describe('manager-only operations', () => {
  beforeEach(() => vi.clearAllMocks());

  // Issuing somebody else a new password is an account takeover in one call.
  it('restricts resetting another person\'s password to a manager', async () => {
    const asChef = await decide('/api/auth/reset-password', 'POST', {
      staff_id: 'S2', sessionRole: 'Head Chef', must_change_password: 0,
    });
    expect(asChef.ok).toBe(false);
    expect(asChef.response.status).toBe(403);

    const asManager = await decide('/api/auth/reset-password', 'POST', {
      staff_id: 'S4', sessionRole: 'Manager', must_change_password: 0,
    });
    expect(asManager.ok).toBe(true);
  });

  it.each([
    ['POST', '/api/migrate/kv-to-d1'],
    ['POST', '/api/staff'],
    ['PUT', '/api/staff/S8'],
    ['DELETE', '/api/staff/S8'],
  ])('403s a non-manager on %s %s', async (m, p) => {
    const d = await decide(p, m, { staff_id: 'S7', sessionRole: 'Cleaner' });
    expect(d.ok).toBe(false);
    expect(d.response.status).toBe(403);
  });

  it('allows a manager', async () => {
    const d = await decide('/api/staff', 'POST', { staff_id: 'S1', sessionRole: 'Manager' });
    expect(d.ok).toBe(true);
  });
});

describe('staff PII redaction', () => {
  const rows = [
    {
      id: 'S8', firstName: 'Tigist', lastName: 'M', role: 'Assistant Chef', status: 'active',
      phone: '+2519...', email: 'a@b.c', password_hash: 'x',
      // The employment record: pay, the documents payroll needs, and the
      // person's private life. None of it has a use on a roster screen.
      base_salary: 9500, salary_period: 'monthly',
      bank_account: '1000123456789', tin: '0052345678', pension_id: 'P-4471',
      employment_type: 'full-time', hire_date: '2024-01-15', end_date: null,
      emergency_contact: 'Abebe', emergency_phone: '+2519...', address: 'Bole, Addis', notes: 'prefers closing shifts',
    },
  ];

  it('keeps the whole record for a manager', () => {
    const out = redactStaffForRole(rows, 'Manager');
    expect(out[0].phone).toBeDefined();
    expect(out[0].email).toBeDefined();
    expect(out[0].base_salary).toBe(9500);
    expect(out[0].bank_account).toBeDefined();
  });

  it('strips phone and email for everyone else', () => {
    const out = redactStaffForRole(rows, 'Cleaner');
    expect(out[0].phone).toBeUndefined();
    expect(out[0].email).toBeUndefined();
    // Time Clock and Shifts still need names and roles.
    expect(out[0].firstName).toBe('Tigist');
    expect(out[0].role).toBe('Assistant Chef');
  });

  it('strips salary and pay figures for everyone but the manager', () => {
    // The whole point of the widening: a cashier reading /api/staff for the
    // Time Clock roster used to receive every colleague's wage.
    for (const role of ['Cashier', 'cleaner', 'head-chef', 'barista', 'accountant', 'delivery-staff']) {
      const out = redactStaffForRole(rows, role);
      expect(out[0].base_salary).toBeUndefined();
      expect(out[0].salary_period).toBeUndefined();
    }
  });

  it('strips bank, tax and pension identifiers for everyone but the manager', () => {
    for (const role of ['Cashier', 'accountant']) {
      const out = redactStaffForRole(rows, role);
      expect(out[0].bank_account).toBeUndefined();
      expect(out[0].tin).toBeUndefined();
      expect(out[0].pension_id).toBeUndefined();
    }
  });

  it("strips the person's private details for everyone but the manager", () => {
    const out = redactStaffForRole(rows, 'Cashier');
    expect(out[0].emergency_contact).toBeUndefined();
    expect(out[0].emergency_phone).toBeUndefined();
    expect(out[0].address).toBeUndefined();
    expect(out[0].notes).toBeUndefined();
  });

  it('never returns a password hash', () => {
    for (const role of ['Manager', 'Cleaner']) {
      const out = redactStaffForRole(rows, role);
      expect(out[0].password_hash).toBeUndefined();
    }
  });
});

// Self-scoped audit reads — the My Activity screen (per-role performance
// dashboard). Every signed-in role can read their own audit trail; nobody
// can read another person's or the system-wide trail without the `audit`
// read grant.
describe('self-scoped audit reads (My Activity)', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['cleaner', 'delivery-staff', 'head-chef', 'head-waiter', 'cashier', 'assistant-chef'])(
    'allows %s to read their own audit entries (actor_id matches staff_id)',
    async (role) => {
      const url = new URL('https://api.test/api/audit?actor_id=S10&from=2026-08-01&to=2026-08-31T23:59:59&limit=500');
      getAuthUser.mockResolvedValue({ staff_id: 'S10', sessionRole: role });
      const d = await authorize(new Request(url), {}, '/api/audit', 'GET', url);
      expect(d.ok).toBe(true);
    }
  );

  it('refuses a non-manager who tries to read another person audit entries', async () => {
    const url = new URL('https://api.test/api/audit?actor_id=S5');
    getAuthUser.mockResolvedValue({ staff_id: 'S10', sessionRole: 'delivery-staff' });
    const d = await authorize(new Request(url), {}, '/api/audit', 'GET', url);
    expect(d.ok).toBe(false);
    expect(d.response.status).toBe(403);
  });

  it('refuses a non-manager who tries to read the system-wide audit (no actor_id)', async () => {
    const url = new URL('https://api.test/api/audit');
    getAuthUser.mockResolvedValue({ staff_id: 'S10', sessionRole: 'delivery-staff' });
    const d = await authorize(new Request(url), {}, '/api/audit', 'GET', url);
    expect(d.ok).toBe(false);
    expect(d.response.status).toBe(403);
  });

  it('still allows a manager to read the system-wide audit (no actor_id)', async () => {
    const url = new URL('https://api.test/api/audit');
    getAuthUser.mockResolvedValue({ staff_id: 'S1', sessionRole: 'manager' });
    const d = await authorize(new Request(url), {}, '/api/audit', 'GET', url);
    expect(d.ok).toBe(true);
  });
});
