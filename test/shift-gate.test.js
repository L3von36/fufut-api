import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleHR } from '../src/handlers/hr.js';
import { resetOrderColumns } from '../src/handlers/orders.js';

/**
 * Clocking off with money still owed.
 *
 * A check still open when its waiter goes home is how a bill is never
 * collected: somebody else clears the table, and by morning nobody remembers
 * who was sitting there. The clock-out is the last cheap moment to catch it.
 *
 * The two things worth pinning are that the refusal actually happens, and that
 * a manager's override is deliberate rather than automatic — a role that is
 * silently exempt makes the gate meaningless the first time it is inconvenient.
 */
function makeEnv({ openEntry = null, orderRows = [] } = {}) {
  const run = vi.fn().mockResolvedValue({ meta: { changes: 1 }, results: [] });
  const boundParams = [];
  const prepare = vi.fn(function (sql) {
    const exec = (params) => ({
      all: async () => {
        if (/PRAGMA table_info\(orders\)/.test(sql)) {
          return {
            results: ['id', 'status', 'table_id', 'payment_status', 'voided_at', 'created', 'created_by', 'total'].map(
              (name) => ({ name })
            ),
          };
        }
        if (/FROM timeclock/.test(sql)) return { results: openEntry ? [openEntry] : [] };
        if (/FROM orders/.test(sql)) return { results: orderRows };
        return { results: [] };
      },
      run,
    });
    return {
      bind: (...params) => {
        boundParams.push({ sql, params });
        return exec(params);
      },
      all: async () => exec([]).all(),
      run,
    };
  });
  return { env: { DB: { prepare, batch: vi.fn().mockResolvedValue([]) } }, run, boundParams };
}

function req(pathname, method, body) {
  const url = new URL('https://pos.fufutcoffee.com' + pathname);
  return {
    pathname,
    method,
    url,
    request: new Request(url.toString(), {
      method,
      body: body === undefined ? null : JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
  };
}

const WAITER = { staff_id: 'S1', sessionRole: 'head-waiter' };
const MANAGER = { staff_id: 'S9', sessionRole: 'manager' };

const ON_SHIFT = { id: 'TC1', staff_id: 'S1', date: '2026-08-17', clock_in: '09:00', clock_out: '', status: 'active' };
const OWED = {
  id: 'Oowed', created_by: 'S1', table_id: '3', total: 740,
  status: 'fulfilled', payment_status: 'unpaid', voided_at: null, created: '2026-08-17T18:00:00',
};

async function call(ctx, env, auth) {
  return handleHR(ctx.pathname, ctx.method, ctx.url, ctx.request, env, auth);
}

describe('POST /api/timeclock/clock-out', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetOrderColumns();
  });

  it('refuses to clock a waiter off while their check is unsettled', async () => {
    const { env, run } = makeEnv({ openEntry: ON_SHIFT, orderRows: [OWED] });

    const res = await call(req('/api/timeclock/clock-out', 'POST', {}), env, WAITER);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.openChecks).toHaveLength(1);
    expect(body.totalOwed).toBe(740);
    expect(body.managerCanOverride).toBe(true);
    // The shift must still be open afterwards.
    expect(run).not.toHaveBeenCalled();
  });

  it('clocks off cleanly when nothing is owed', async () => {
    const { env, boundParams } = makeEnv({ openEntry: ON_SHIFT, orderRows: [] });

    const res = await call(req('/api/timeclock/clock-out', 'POST', {}), env, WAITER);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(boundParams.some((b) => /UPDATE timeclock SET clock_out/.test(b.sql))).toBe(true);
  });

  // Settled checks are excluded by listOpenChecks' SQL, which this fake stands
  // in for rather than executes — so there is no honest assertion to make about
  // it here. It is covered where it is decided, in the query itself.

  it('does not hold one person to another person’s open check', async () => {
    const { env } = makeEnv({
      openEntry: ON_SHIFT,
      orderRows: [{ ...OWED, created_by: 'S2' }],
    });

    const res = await call(req('/api/timeclock/clock-out', 'POST', {}), env, WAITER);
    expect(res.status).toBe(200);
  });

  // The override has to be asked for. A manager who is simply exempt would mean
  // the gate stops applying to the person most able to ignore it.
  it('refuses a manager too unless they force it', async () => {
    const { env } = makeEnv({ openEntry: { ...ON_SHIFT, staff_id: 'S9' }, orderRows: [{ ...OWED, created_by: 'S9' }] });

    const res = await call(req('/api/timeclock/clock-out', 'POST', {}), env, MANAGER);
    expect(res.status).toBe(409);
  });

  it('lets a manager force it through', async () => {
    const { env } = makeEnv({ openEntry: { ...ON_SHIFT, staff_id: 'S9' }, orderRows: [{ ...OWED, created_by: 'S9' }] });

    const res = await call(req('/api/timeclock/clock-out', 'POST', { force: true }), env, MANAGER);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.forced).toBe(true);
  });

  // force is a manager's word. A waiter sending it must change nothing.
  it('ignores force from a waiter', async () => {
    const { env } = makeEnv({ openEntry: ON_SHIFT, orderRows: [OWED] });

    const res = await call(req('/api/timeclock/clock-out', 'POST', { force: true }), env, WAITER);
    expect(res.status).toBe(409);
  });

  it('refuses when there is no open shift', async () => {
    const { env } = makeEnv({ openEntry: null, orderRows: [] });
    const res = await call(req('/api/timeclock/clock-out', 'POST', {}), env, WAITER);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/not clocked in/i);
  });
});

describe('POST /api/timeclock/clock-in', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetOrderColumns();
  });

  it('opens a shift', async () => {
    const { env, boundParams } = makeEnv({ openEntry: null });
    const res = await call(req('/api/timeclock/clock-in', 'POST', {}), env, WAITER);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.staffId).toBe('S1');
    expect(body.clockIn).toMatch(/^\d{2}:\d{2}$/);
    expect(boundParams.some((b) => /INSERT INTO timeclock/.test(b.sql))).toBe(true);
  });

  // Two taps must not become two shifts and twice the hours.
  it('will not open a second shift on top of an open one', async () => {
    const { env } = makeEnv({ openEntry: ON_SHIFT });
    const res = await call(req('/api/timeclock/clock-in', 'POST', {}), env, WAITER);
    expect(res.status).toBe(409);
  });

  // The security model of the self-service routes.
  it('ignores a staffId sent by a waiter and acts on themselves', async () => {
    const { env, boundParams } = makeEnv({ openEntry: null });
    await call(req('/api/timeclock/clock-in', 'POST', { staffId: 'S7' }), env, WAITER);

    const insert = boundParams.find((b) => /INSERT INTO timeclock/.test(b.sql));
    expect(insert.params[1]).toBe('S1');
  });

  it('honours a staffId from a manager', async () => {
    const { env, boundParams } = makeEnv({ openEntry: null });
    await call(req('/api/timeclock/clock-in', 'POST', { staffId: 'S7' }), env, MANAGER);

    const insert = boundParams.find((b) => /INSERT INTO timeclock/.test(b.sql));
    expect(insert.params[1]).toBe('S7');
  });
});
