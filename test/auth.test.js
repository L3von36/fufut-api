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

  it('allows an authenticated staff member through', async () => {
    const d = await decide('/api/orders', 'GET', { staff_id: 'S1', sessionRole: 'Cleaner' });
    expect(d.ok).toBe(true);
  });

  it('reads SSE as protected', async () => {
    const d = await decide('/api/events/kitchen', 'GET', null);
    expect(d.response.status).toBe(401);
  });
});

describe('manager-only operations', () => {
  beforeEach(() => vi.clearAllMocks());

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
    { id: 'S8', firstName: 'Tigist', lastName: 'M', role: 'Assistant Chef', phone: '+2519...', email: 'a@b.c', password_hash: 'x' },
  ];

  it('keeps contact details for a manager', () => {
    const out = redactStaffForRole(rows, 'Manager');
    expect(out[0].phone).toBeDefined();
    expect(out[0].email).toBeDefined();
  });

  it('strips phone and email for everyone else', () => {
    const out = redactStaffForRole(rows, 'Cleaner');
    expect(out[0].phone).toBeUndefined();
    expect(out[0].email).toBeUndefined();
    // Time Clock and Shifts still need names and roles.
    expect(out[0].firstName).toBe('Tigist');
    expect(out[0].role).toBe('Assistant Chef');
  });

  it('never returns a password hash', () => {
    for (const role of ['Manager', 'Cleaner']) {
      const out = redactStaffForRole(rows, role);
      expect(out[0].password_hash).toBeUndefined();
    }
  });
});
