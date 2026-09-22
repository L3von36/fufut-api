import { describe, it, expect, vi } from 'vitest';
import { authorize, resourceForPath } from '../src/auth.js';
import { handleTables } from '../src/handlers/tables.js';

/**
 * The kitchen's table-turn: POST /api/tables/:id/free (owner's call, 2026-09).
 *
 * Two layers get tested, exactly as they sit in production:
 *   1. authorize() — the matrix. `tables` READ joins the chef grants, and the
 *      free action is its own `table-free` resource (the menu-availability
 *      pattern) so the kitchen never needs the generic tables write.
 *   2. handleTables() — the endpoint. The free refuses while a check on the
 *      table is unsettled, answers alreadyFree for an unoccupied table, and
 *      resets the party the way checkout does.
 *
 * getAuthUser talks to D1; stub it so the authorize tests cover policy, not
 * storage (same harness as auth.test.js).
 */
vi.mock('../src/handlers/session.js', () => ({
  getAuthUser: vi.fn(),
}));
import { getAuthUser } from '../src/handlers/session.js';

async function decide(pathname, method, session) {
  getAuthUser.mockResolvedValue(session);
  return authorize(new Request('https://api.test/'), {}, pathname, method);
}

const session = (role) => ({
  staff_id: 'S2',
  sessionRole: role,
  firstName: 'Test',
  lastName: role,
});

describe('matrix: the kitchen can see the floor', () => {
  it.each(['head-chef', 'assistant-chef'])('%s may GET /api/tables', async (role) => {
    const d = await decide('/api/tables', 'GET', session(role));
    expect(d.ok).toBe(true);
  });

  it.each(['head-chef', 'assistant-chef'])('%s may POST /api/tables/:id/free', async (role) => {
    expect(resourceForPath('/api/tables/T7/free')).toBe('table-free');
    const d = await decide('/api/tables/T7/free', 'POST', session(role));
    expect(d.ok).toBe(true);
  });

  it.each(['head-waiter', 'manager'])('%s keeps the free-table write', async (role) => {
    const d = await decide('/api/tables/T7/free', 'POST', session(role));
    expect(d.ok).toBe(true);
  });

  it('the head-chef still cannot seat, reassign or rename (generic tables write)', async () => {
    const d = await decide('/api/tables/T7', 'PUT', session('head-chef'));
    expect(d.ok).toBe(false);
  });

  it.each(['cashier', 'barista', 'cleaner', 'delivery-staff'])(
    'refuses %s the free-table write',
    async (role) => {
      const d = await decide('/api/tables/T7/free', 'POST', session(role));
      expect(d.ok).toBe(false);
      expect(d.response.status).toBe(403);
    }
  );
});

/**
 * D1 fake for the endpoint: canned result-sets keyed by SQL shape, mirroring
 * orders-open-tabs.test.js. `run` records every UPDATE so tests can assert
 * the party actually got reset.
 */
function makeEnv({ tableRows = [], orderRows = [] } = {}) {
  const run = vi.fn().mockResolvedValue({ meta: { changes: 1 }, results: [] });
  const prepare = vi.fn(function (sql) {
    return {
      bind: () => ({
        all: async () => {
          if (/FROM orders/.test(sql)) return { results: orderRows };
          if (/FROM tables WHERE id/.test(sql)) return { results: tableRows };
          return { results: [] };
        },
        run,
      }),
    };
  });
  return { env: { DB: { prepare, batch: vi.fn() } }, run, prepare };
}

function callFree(env, role = 'head-chef') {
  const url = new URL('https://pos.fufutcoffee.com/api/tables/T7/free');
  const request = new Request(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  return handleTables(
    '/api/tables/T7/free',
    'POST',
    url,
    request,
    env,
    session(role)
  );
}

const OCCUPIED_TABLE = [{ id: 'T7', number: '7', status: 'occupied' }];

describe('POST /api/tables/:id/free', () => {
  it('frees a checkless occupied table: status, timer, guests, server all reset', async () => {
    const { env, prepare } = makeEnv({ tableRows: OCCUPIED_TABLE });
    const res = await callFree(env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.freed).toBe(true);
    const resetSql = prepare.mock.calls.map((c) => c[0]).find((s) => s.includes("status = 'available'"));
    expect(resetSql).toContain("seated_at = ''");
    expect(resetSql).toContain('guests = 0');
  });

  it('refuses while an open check on the table is unpaid (409, check ids named)', async () => {
    const { env } = makeEnv({
      tableRows: OCCUPIED_TABLE,
      orderRows: [
        { id: 'O1', table_id: '7', payment_status: 'unpaid' },
        { id: 'O2', table_id: '7', payment_status: 'partial' },
      ],
    });
    const res = await callFree(env);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.unsettledChecks).toEqual(['O1', 'O2']);
    expect(body.error).toContain('Table 7');
  });

  it('a fully paid table frees — settled money is not a blocker', async () => {
    const { env } = makeEnv({
      tableRows: OCCUPIED_TABLE,
      orderRows: [{ id: 'O1', table_id: '7', payment_status: 'paid' }],
    });
    const res = await callFree(env);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.freed).toBe(true);
  });

  it('tickets the WHERE clause filters out never block the free', async () => {
    // The endpoint's order read only returns active, non-voided tickets; an
    // empty result means nothing survived to block the free.
    const { env, prepare } = makeEnv({ tableRows: OCCUPIED_TABLE, orderRows: [] });
    const res = await callFree(env);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(prepare.mock.calls.some((c) => String(c[0]).includes("status = 'available'"))).toBe(true);
  });

  it('answers alreadyFree for a table nobody is sitting at', async () => {
    const { env } = makeEnv({ tableRows: [{ id: 'T7', number: '7', status: 'available' }] });
    const res = await callFree(env);
    const body = await res.json();
    expect(body).toEqual({ ok: true, alreadyFree: true });
  });

  it('404s a table that does not exist', async () => {
    const { env } = makeEnv({ tableRows: [] });
    const res = await callFree(env);
    expect(res.status).toBe(404);
  });

  it.each(['barista', 'cashier', 'cleaner', 'delivery-staff'])(
    'the endpoint itself refuses %s (defence in depth under the matrix)',
    async (role) => {
      const { env } = makeEnv({ tableRows: OCCUPIED_TABLE });
      const res = await callFree(env, role);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain('free a table');
    }
  );

  it('the assistant chef can run the same turn', async () => {
    const { env, prepare } = makeEnv({ tableRows: OCCUPIED_TABLE });
    const res = await callFree(env, 'assistant-chef');
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(prepare.mock.calls.some((c) => String(c[0]).includes("status = 'available'"))).toBe(true);
  });
});
