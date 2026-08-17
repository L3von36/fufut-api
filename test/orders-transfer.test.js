import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleOrders, resetOrderColumns } from '../src/handlers/orders.js';

/**
 * Moving a check to another table.
 *
 * The operation exists to remove the reason staff clear a table that still owes
 * money: a guest changes seats and there is otherwise nothing to do but drop
 * the tab off the floor plan. So the tests care about two things — that the
 * destination is subject to the same exclusivity as seating anywhere else, and
 * that the table being left is only freed once nothing is owed on it.
 *
 * D1 fake keyed on the shape of the SQL, matching orders-open-tabs.test.js.
 */
function makeEnv({ orderRows = [], tableRows = {}, reservationRows = [], openRows = [], columns = null } = {}) {
  const run = vi.fn().mockResolvedValue({ meta: { changes: 1 }, results: [] });
  const boundParams = [];
  const prepare = vi.fn(function (sql) {
    return {
      bind: (...params) => {
        boundParams.push({ sql, params });
        return {
          all: async () => {
            if (/PRAGMA table_info\(orders\)/.test(sql)) {
              return {
                results: (columns || ['id', 'status', 'table_id', 'payment_status', 'voided_at', 'created']).map(
                  (name) => ({ name })
                ),
              };
            }
            if (/FROM orders WHERE id/.test(sql)) return { results: orderRows };
            if (/FROM reservations/.test(sql)) return { results: reservationRows };
            if (/FROM tables WHERE number/.test(sql)) {
              const wanted = String(params[0]);
              return { results: tableRows[wanted] ? [tableRows[wanted]] : [] };
            }
            // The open-checks sweep used to decide whether to free the old table.
            if (/FROM orders WHERE/.test(sql)) return { results: openRows };
            return { results: [] };
          },
          run,
        };
      },
    };
  });
  return { env: { DB: { prepare, batch: vi.fn().mockResolvedValue([]) } }, run, boundParams };
}

function transferReq(orderId, body) {
  const pathname = `/api/orders/${orderId}/transfer`;
  const url = new URL('https://pos.fufutcoffee.com' + pathname);
  return {
    pathname,
    method: 'POST',
    url,
    request: new Request(url.toString(), {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
  };
}

const WAITER = { sessionRole: 'head-waiter', staff_id: 'S1' };
const MANAGER = { sessionRole: 'manager', staff_id: 'S9' };

const OPEN_CHECK = {
  id: 'Otab01', table_id: '3', status: 'new', payment_status: 'unpaid',
  voided_at: null, total: 240, created: '2026-08-17T18:00:00',
};

const FREE_TABLE = { id: 'T005', number: '5', status: 'available', guests: 0, server: '', seated_at: '' };
const BUSY_TABLE = { id: 'T007', number: '7', status: 'occupied', guests: 4, server: 'Yonas', seated_at: '2026-08-17T18:40:00.000Z' };
const SOURCE_TABLE = { id: 'T003', number: '3', status: 'occupied', guests: 2, server: 'Yonas', seated_at: '2026-08-17T18:00:00.000Z' };

async function run(ctx, env, auth) {
  return handleOrders(ctx.pathname, ctx.method, ctx.url, ctx.request, env, auth);
}

describe('POST /api/orders/:id/transfer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetOrderColumns();
  });

  it('moves the check and points it at the new table', async () => {
    const { env, boundParams } = makeEnv({
      orderRows: [OPEN_CHECK],
      tableRows: { 5: FREE_TABLE, 3: SOURCE_TABLE },
    });

    const res = await run(transferReq('Otab01', { tableNumber: '5' }), env, WAITER);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, moved: true, from: '3', to: '5' });

    const move = boundParams.find((b) => /UPDATE orders SET table_id/.test(b.sql));
    expect(move, 'the check should be repointed').toBeTruthy();
    expect(move.params[0]).toBe('5');
  });

  // The whole point of the feature: the table they left goes back on the floor.
  it('frees the table they left when nothing is owed on it', async () => {
    const { env, boundParams } = makeEnv({
      orderRows: [OPEN_CHECK],
      tableRows: { 5: FREE_TABLE, 3: SOURCE_TABLE },
      openRows: [],
    });

    const body = await (await run(transferReq('Otab01', { tableNumber: '5' }), env, WAITER)).json();

    expect(body.sourceFreed).toBe(true);
    expect(boundParams.some((b) => /SET status = 'available'/.test(b.sql))).toBe(true);
  });

  // Another party's tab may still be sitting there — freeing it would repeat
  // the exact mistake this feature exists to prevent.
  it('leaves the old table occupied when another check is still open on it', async () => {
    const { env, boundParams } = makeEnv({
      orderRows: [OPEN_CHECK],
      tableRows: { 5: FREE_TABLE, 3: SOURCE_TABLE },
      openRows: [OPEN_CHECK, { id: 'Oother', table_id: '3', status: 'new', payment_status: 'unpaid' }],
    });

    const body = await (await run(transferReq('Otab01', { tableNumber: '5' }), env, WAITER)).json();

    expect(body.sourceFreed).toBe(false);
    expect(boundParams.some((b) => /SET status = 'available'/.test(b.sql))).toBe(false);
  });

  it('refuses a destination that already has a party on it', async () => {
    const { env } = makeEnv({
      orderRows: [OPEN_CHECK],
      tableRows: { 7: BUSY_TABLE, 3: SOURCE_TABLE },
    });

    const res = await run(transferReq('Otab01', { tableNumber: '7' }), env, WAITER);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.occupiedBy).toMatchObject({ server: 'Yonas', guests: 4 });
  });

  it('lets a manager move onto an occupied table', async () => {
    const { env } = makeEnv({
      orderRows: [OPEN_CHECK],
      tableRows: { 7: BUSY_TABLE, 3: SOURCE_TABLE },
    });

    const res = await run(transferReq('Otab01', { tableNumber: '7' }), env, MANAGER);
    expect(res.status).toBe(200);
    expect((await res.json()).moved).toBe(true);
  });

  it('refuses a destination inside a booking window', async () => {
    const start = new Date(Date.now() + 10 * 60000).toISOString();
    const end = new Date(Date.now() + 100 * 60000).toISOString();
    const { env } = makeEnv({
      orderRows: [OPEN_CHECK],
      tableRows: { 5: FREE_TABLE, 3: SOURCE_TABLE },
      reservationRows: [
        { id: 'R1', name: 'Selam', guests: 2, status: 'confirmed', start_at: start, end_at: end, released_at: null, no_show_at: null },
      ],
    });

    const res = await run(transferReq('Otab01', { tableNumber: '5' }), env, WAITER);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.reservation).toMatchObject({ name: 'Selam' });
  });

  it('will not move a check that is already settled', async () => {
    const { env } = makeEnv({
      orderRows: [{ ...OPEN_CHECK, payment_status: 'paid' }],
      tableRows: { 5: FREE_TABLE, 3: SOURCE_TABLE },
    });

    const res = await run(transferReq('Otab01', { tableNumber: '5' }), env, WAITER);
    expect(res.status).toBe(409);
  });

  it('will not move a voided check', async () => {
    const { env } = makeEnv({
      orderRows: [{ ...OPEN_CHECK, voided_at: '2026-08-17T19:00:00.000Z' }],
      tableRows: { 5: FREE_TABLE, 3: SOURCE_TABLE },
    });

    const res = await run(transferReq('Otab01', { tableNumber: '5' }), env, WAITER);
    expect(res.status).toBe(409);
  });

  // Moving a check where it already is should disturb neither table.
  it('is a no-op when the destination is the current table', async () => {
    const { env, boundParams } = makeEnv({
      orderRows: [OPEN_CHECK],
      tableRows: { 3: SOURCE_TABLE },
    });

    const body = await (await run(transferReq('Otab01', { tableNumber: '3' }), env, WAITER)).json();

    expect(body).toMatchObject({ ok: true, moved: false });
    expect(boundParams.some((b) => /UPDATE tables/.test(b.sql))).toBe(false);
  });

  it('rejects a missing or unknown destination', async () => {
    const a = makeEnv({ orderRows: [OPEN_CHECK], tableRows: { 3: SOURCE_TABLE } });
    expect((await run(transferReq('Otab01', {}), a.env, WAITER)).status).toBe(400);

    const b = makeEnv({ orderRows: [OPEN_CHECK], tableRows: { 3: SOURCE_TABLE } });
    expect((await run(transferReq('Otab01', { tableNumber: '99' }), b.env, WAITER)).status).toBe(404);
  });

  it('404s an order that does not exist', async () => {
    const { env } = makeEnv({ orderRows: [], tableRows: { 5: FREE_TABLE } });
    expect((await run(transferReq('Ononsuch', { tableNumber: '5' }), env, WAITER)).status).toBe(404);
  });
});
