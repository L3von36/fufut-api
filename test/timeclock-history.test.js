import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleHR } from '../src/handlers/hr.js';
import { authorize } from '../src/auth.js';

// getAuthUser talks to D1; stub it so the reachability tests cover policy,
// not storage. Same arrangement as auth.test.js.
vi.mock('../src/handlers/session.js', () => ({
  getAuthUser: vi.fn(),
}));

/**
 * My own shift history, and nobody else's.
 *
 * The Time Clock screen for a role without the roster grant used to show the
 * current state and the two buttons and nothing else — the one person whose
 * hours a waiter can never see was themselves. `/api/timeclock/me/history`
 * closes that, and the two things worth pinning are exactly the two ways it
 * could go wrong: the route must be reachable by a role with no `timeclock`
 * grant at all (otherwise the waiter is back to an empty screen), and it must
 * answer only the caller's own rows (otherwise it is a roster leak with a
 * friendlier name).
 */

const WAITER = { staff_id: 'S1', sessionRole: 'head-waiter' };
const MANAGER = { staff_id: 'S9', sessionRole: 'manager' };

const SHIFTS = [
  { id: 'TC1', staff_id: 'S1', date: '2026-08-27', clock_in: '08:20', clock_out: '12:04', hours: 3.7, status: 'completed' },
  { id: 'TC2', staff_id: 'S1', date: '2026-08-26', clock_in: '09:00', clock_out: '', hours: 0, status: 'active' },
  { id: 'TC3', staff_id: 'S2', date: '2026-08-26', clock_in: '10:00', clock_out: '18:00', hours: 8, status: 'completed' },
];

function makeEnv(rows = SHIFTS) {
  const boundParams = [];
  const prepare = vi.fn(function (sql) {
    const exec = (params) => ({
      all: async () => {
        if (/FROM timeclock/.test(sql)) return { results: rows.filter((r) => r.staff_id === (params[0] || r.staff_id)) };
        return { results: [] };
      },
      run: async () => ({ meta: { changes: 1 }, results: [] }),
    });
    return {
      bind: (...params) => {
        boundParams.push({ sql, params });
        return exec(params);
      },
      all: async () => exec([]).all(),
      run: async () => ({ meta: { changes: 1 }, results: [] }),
    };
  });
  return { env: { DB: { prepare, batch: vi.fn().mockResolvedValue([]) } }, boundParams };
}

function req(pathname, method = 'GET') {
  const url = new URL('https://pos.fufutcoffee.com' + pathname);
  return { pathname, method, url, request: new Request(url.toString(), { method }) };
}

describe('GET /api/timeclock/me/history', () => {
  beforeEach(() => vi.clearAllMocks());

  it('answers a waiter their own shifts, newest first', async () => {
    const { env } = makeEnv();
    const res = await handleHR('/api/timeclock/me/history', 'GET', req('/api/timeclock/me/history').url, req('/api/timeclock/me/history').request, env, WAITER);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.staffId).toBe('S1');
    // The colleague's row never crosses the wire.
    expect(body.entries).toHaveLength(2);
    expect(body.entries.every((e) => e.staffId === 'S1')).toBe(true);
    expect(body.entries[0].date).toBe('2026-08-27');
    // The POS roster table reads the camelCase spelling; an open shift's
    // clock_out is a blank string in storage and null on the wire.
    expect(body.entries[0].clockIn).toBe('08:20');
    expect(body.entries[1].clockOut).toBeNull();
  });

  it('ignores a waiter asking for a colleague — the query still scopes to the caller', async () => {
    const { env, boundParams } = makeEnv();
    const url = new URL('https://pos.fufutcoffee.com/api/timeclock/me/history?staffId=S2');
    await handleHR('/api/timeclock/me/history', 'GET', url, new Request(url.toString()), env, WAITER);

    const history = boundParams.find((b) => /ORDER BY date DESC/.test(b.sql));
    expect(history.params[0]).toBe('S1');
  });

  it('honours a staffId from a manager, who already holds the roster', async () => {
    const { env, boundParams } = makeEnv();
    const url = new URL('https://pos.fufutcoffee.com/api/timeclock/me/history?staffId=S2');
    await handleHR('/api/timeclock/me/history', 'GET', url, new Request(url.toString()), env, MANAGER);

    const history = boundParams.find((b) => /ORDER BY date DESC/.test(b.sql));
    expect(history.params[0]).toBe('S2');
  });

  it('clamps the limit into 1..90 with a default of 14', async () => {
    const { env, boundParams } = makeEnv();
    const callWith = async (qs) => {
      const url = new URL('https://pos.fufutcoffee.com/api/timeclock/me/history' + qs);
      await handleHR('/api/timeclock/me/history', 'GET', url, new Request(url.toString()), env, WAITER);
    };
    await callWith('');
    await callWith('?limit=500');
    await callWith('?limit=0');

    const limits = boundParams.filter((b) => /ORDER BY date DESC/.test(b.sql)).map((b) => b.params[1]);
    expect(limits).toEqual([14, 90, 1]);
  });

  it('refuses 400 when the session has no staff record', async () => {
    const { env } = makeEnv();
    const res = await handleHR('/api/timeclock/me/history', 'GET', req('/api/timeclock/me/history').url, req('/api/timeclock/me/history').request, env, { sessionRole: 'head-waiter' });
    expect(res.status).toBe(400);
  });
});

describe('route reachability', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is self-service: a waiter with no timeclock grant reaches it', async () => {
    const { getAuthUser } = await import('../src/handlers/session.js');
    getAuthUser.mockResolvedValue(WAITER);
    const d = await authorize(new Request('https://api.test/'), {}, '/api/timeclock/me/history', 'GET');
    expect(d.ok).toBe(true);
  });

  it('stays closed to anonymous callers', async () => {
    const { getAuthUser } = await import('../src/handlers/session.js');
    getAuthUser.mockResolvedValue(null);
    const d = await authorize(new Request('https://api.test/'), {}, '/api/timeclock/me/history', 'GET');
    expect(d.ok).toBe(false);
    expect(d.response.status).toBe(401);
  });
});
