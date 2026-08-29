import { describe, it, expect, vi } from 'vitest';
import { handleTables } from '../src/handlers/tables.js';

/**
 * Who owns a table, and who may say so.
 *
 * Two rules live here:
 *   1. Assignment is a manager's decision. The floor staff (head-waiter,
 *      cashier) run the tables — status, guests, notes, seating — but the
 *      name on the table can only be set by a manager, and only through the
 *      UPDATE/CREATE paths this handler gates.
 *   2. A head-waiter's floor plan is their section of the work, not the room:
 *      the list they fetch shows only the tables assigned to them by name.
 *      The manager (who makes the assignments) and the cashier (who clears
 *      bills across every section) still see the whole floor.
 */
function makeEnv({ tableRow = null, tableRows = [], reservationRows = [], claimChanges = 1 } = {}) {
  const audits = [];
  const run = vi.fn().mockResolvedValue({ meta: { changes: claimChanges }, results: [] });
  const prepare = vi.fn(function (sql) {
    return {
      bind: (...params) => ({
        all: async () => {
          if (/FROM tables WHERE id/.test(sql)) return { results: tableRow ? [tableRow] : [] };
          if (/FROM tables ORDER BY number/.test(sql)) return { results: tableRows };
          if (/FROM reservations/.test(sql)) return { results: reservationRows };
          return { results: [] };
        },
        run,
      }),
    };
  });
  return { env: { DB: { prepare, batch: vi.fn().mockResolvedValue([]) } }, audits, run, prepare };
}

function req(pathname, method, body) {
  const url = new URL('https://backoffice.fufutcoffee.com' + pathname);
  const request = new Request(url.toString(), {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
  });
  return { pathname, method, url, request };
}

async function call(pathname, method, auth, body, envOpts = {}) {
  const { env } = makeEnv(envOpts);
  const r = req(pathname, method, body);
  return handleTables(r.pathname, r.method, r.url, r.request, env, auth);
}

const WAITER = { staff_id: 'S1', sessionRole: 'head-waiter', firstName: 'Yonas' };
const CASHIER = { staff_id: 'S2', sessionRole: 'cashier', firstName: 'Sara' };
const MANAGER = { staff_id: 'S9', sessionRole: 'manager', firstName: 'Amanuel' };

const FLOOR = [
  { id: 'T1', number: '1', status: 'available', server: 'Yonas', guests: 0, seated_at: '' },
  { id: 'T2', number: '2', status: 'occupied', server: 'Abebe', guests: 3, seated_at: '2026-08-29T10:00:00.000Z' },
  { id: 'T3', number: '3', status: 'available', server: '', guests: 0, seated_at: '' },
];

describe('GET /api/tables — waiter-scoped visibility', () => {
  it('head-waiter sees only the tables assigned to them', async () => {
    const res = await call('/api/tables', 'GET', WAITER, undefined, { tableRows: FLOOR });
    expect(res.status).toBe(200);
    const rows = await res.json();
    expect(rows.map((t) => t.id)).toEqual(['T1']);
  });

  it('manager sees the whole floor', async () => {
    const res = await call('/api/tables', 'GET', MANAGER, undefined, { tableRows: FLOOR });
    const rows = await res.json();
    expect(rows.map((t) => t.id)).toEqual(['T1', 'T2', 'T3']);
  });

  it('cashier sees the whole floor (bills span sections)', async () => {
    const res = await call('/api/tables', 'GET', CASHIER, undefined, { tableRows: FLOOR });
    const rows = await res.json();
    expect(rows.length).toBe(3);
  });

  it('head-waiter with no name on the session sees nothing rather than every unassigned table', async () => {
    const res = await call('/api/tables', 'GET', { staff_id: 'S1', sessionRole: 'head-waiter' }, undefined, {
      tableRows: FLOOR,
    });
    const rows = await res.json();
    expect(rows).toEqual([]);
  });

  it('name matching ignores case and surrounding spaces', async () => {
    const rows = FLOOR.map((t) => (t.id === 'T3' ? { ...t, server: '  YONAS ' } : t));
    const res = await call('/api/tables', 'GET', WAITER, undefined, { tableRows: rows });
    const list = await res.json();
    expect(list.map((t) => t.id)).toEqual(['T1', 'T3']);
  });
});

describe('PUT /api/tables/:id — manager-only assignment', () => {
  const T1 = FLOOR[0];

  it('head-waiter cannot write a new server onto a table', async () => {
    const res = await call('/api/tables/T1', 'PUT', WAITER, { server: 'Abebe', status: 'occupied' }, { tableRow: T1 });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/Only a manager/);
  });

  it('cashier cannot write a new server onto a table either', async () => {
    const res = await call('/api/tables/T1', 'PUT', CASHIER, { server: 'Abebe' }, { tableRow: T1 });
    expect(res.status).toBe(403);
  });

  it('manager can assign any server', async () => {
    const res = await call('/api/tables/T1', 'PUT', MANAGER, { server: 'Abebe', status: 'occupied' }, { tableRow: T1 });
    expect(res === null || res.status === undefined).toBe(true); // falls through to the generic write
  });

  it('echoing the stored server back is allowed (seat/checkout flows spread the fetched row)', async () => {
    const res = await call('/api/tables/T1', 'PUT', WAITER, { server: 'Yonas', status: 'occupied' }, { tableRow: T1 });
    expect(res === null || res.status === undefined).toBe(true);
  });

  it('clearing the server is allowed for everyone (freeing a table resets the party)', async () => {
    const occupied = FLOOR[1];
    const res = await call('/api/tables/T2', 'PUT', WAITER, { server: '', status: 'available', guests: 0 }, { tableRow: occupied });
    expect(res === null || res.status === undefined).toBe(true);
  });

  it('status-only changes (no server in the body) are untouched', async () => {
    const res = await call('/api/tables/T1', 'PUT', WAITER, { status: 'cleaning' }, { tableRow: T1 });
    expect(res === null || res.status === undefined).toBe(true);
  });
});

describe('POST /api/tables — no assignment smuggled in through CREATE', () => {
  it('head-waiter cannot create a table with a server already on it', async () => {
    const res = await call('/api/tables', 'POST', WAITER, { number: 9, capacity: 4, server: 'Yonas' });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/Only a manager/);
  });

  it('creating a table without a server falls through as before', async () => {
    const res = await call('/api/tables', 'POST', WAITER, { number: 9, capacity: 4 });
    expect(res === null || res.status === undefined).toBe(true);
  });
});
