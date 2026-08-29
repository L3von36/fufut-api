import { describe, it, expect, vi, afterEach } from 'vitest';
import { addToOpenDrawerCash } from '../src/lib/drawer.js';
import { handleOrders, resetOrderItemColumns } from '../src/handlers/orders.js';

/**
 * The till's cash tally.
 *
 * Until this existed, nothing ever wrote `cashdrawers.cash_sales`: the drawer's
 * "expected" figure was just the opening float, so every birr of cash taken
 * during a shift surfaced at Z-count as unexplained overage. A cashier who
 * counted perfectly still showed +ETB whatever they sold. These tests pin the
 * three places money crosses the till: settlement breakdowns, direct payments
 * and refunds.
 */

function makeEnv({ orderRows = [], itemRows = [], overrides = {} } = {}) {
  const run = vi.fn().mockResolvedValue({ meta: { changes: 1 }, results: [] });
  const batch = vi.fn().mockResolvedValue([]);
  const boundParams = [];
  const prepare = vi.fn(function (sql) {
    return {
      bind: (...params) => {
        boundParams.push({ sql, params });
        return {
          all: async () => {
            for (const [frag, result] of Object.entries(overrides)) {
              if (sql.includes(frag)) return result;
            }
            if (/FROM orders WHERE id/.test(sql)) return { results: orderRows };
            if (/FROM order_items/.test(sql)) return { results: itemRows };
            return { results: [] };
          },
          run,
        };
      },
    };
  });
  const env = { DB: { prepare, batch } };
  return { env, run, batch, boundParams };
}

function makeRequest(pathname, method = 'GET', body = null) {
  const url = new URL('https://pos.fufutcoffee.com' + pathname);
  const req = new Request(url.toString(), {
    method,
    body: body ? JSON.stringify(body) : null,
    headers: { 'Content-Type': 'application/json' },
  });
  return { pathname, method, url, request: req };
}

const WAITER = { staff_id: 'S6', sessionRole: 'cashier', firstName: 'Yonas' };

const OPEN_ORDER = {
  id: 'Otab0001', items: '2xMacchiato', total: 260, payment: 'unpaid',
  type: 'dine-in', table_id: '3', status: 'new', subtotal: 260,
  tip: 0, created: '2026-08-25T00:00:00', payment_status: 'unpaid',
};

function drawerUpdateIn(boundParams) {
  return boundParams.find((b) => /UPDATE cashdrawers\s+SET cash_sales/.test(b.sql));
}

describe('addToOpenDrawerCash', () => {
  afterEach(() => vi.restoreAllMocks());

  it('adds the amount to the newest open drawer', async () => {
    const { env, boundParams } = makeEnv();
    const applied = await addToOpenDrawerCash(env, 130);
    expect(applied).toBe(130);
    const upd = drawerUpdateIn(boundParams);
    expect(upd).toBeTruthy();
    expect(upd.params).toEqual([130]);
    // Newest open drawer only, never every drawer at once.
    expect(upd.sql).toMatch(/ORDER BY created DESC LIMIT 1/);
  });

  it('subtracts for a refund without a separate code path', async () => {
    const { env, boundParams } = makeEnv();
    const applied = await addToOpenDrawerCash(env, -90);
    expect(applied).toBe(-90);
    expect(drawerUpdateIn(boundParams).params).toEqual([-90]);
  });

  it('reports nothing applied when no drawer is open', async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 0 }, results: [] });
    const prepare = vi.fn((sql) => ({
      bind: (...params) => ({ all: async () => ({ results: [] }), run }),
    }));
    const applied = await addToOpenDrawerCash({ DB: { prepare } }, 130);
    expect(applied).toBeNull();
  });

  it('never throws when the write fails — the payment must survive it', async () => {
    const run = vi.fn().mockRejectedValue(new Error('d1 unavailable'));
    const prepare = vi.fn((sql) => ({
      bind: (...params) => ({ all: async () => ({ results: [] }), run }),
    }));
    const applied = await addToOpenDrawerCash({ DB: { prepare } }, 130);
    expect(applied).toBeNull();
  });

  it('ignores a zero delta', async () => {
    const { env, boundParams } = makeEnv();
    expect(await addToOpenDrawerCash(env, 0)).toBeNull();
    expect(drawerUpdateIn(boundParams)).toBeUndefined();
  });
});

describe('settlement puts its cash in the till', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetOrderItemColumns();
  });

  it('counts the cash legs of a split settlement, and only those', async () => {
    const { env, boundParams } = makeEnv({ orderRows: [OPEN_ORDER] });
    const ctx = makeRequest('/api/orders/Otab0001', 'PUT', {
      status: 'served',
      total: 260,
      subtotal: 260,
      tip: 0,
      paymentBreakdown: [
        { method: 'cash', amount: 100 },
        { method: 'telebirr', amount: 160 },
      ],
    });

    await handleOrders(ctx.pathname, ctx.method, ctx.url, ctx.request, env, WAITER);

    const upd = drawerUpdateIn(boundParams);
    expect(upd).toBeTruthy();
    // The telebirr leg never entered the drawer, so it must not be in the tally.
    expect(upd.params).toEqual([100]);
  });

  it('does not double-count a retried settlement', async () => {
    // The retried PUT finds the payment rows already there and returns before
    // the drawer is touched — the same idempotency that guards the payments.
    const { env, boundParams } = makeEnv({
      orderRows: [OPEN_ORDER],
      overrides: {
        "SELECT id FROM payments WHERE order_id": { results: [{ id: 'PM1' }] },
      },
    });
    const ctx = makeRequest('/api/orders/Otab0001', 'PUT', {
      status: 'served',
      total: 260,
      paymentBreakdown: [{ method: 'cash', amount: 260 }],
    });

    await handleOrders(ctx.pathname, ctx.method, ctx.url, ctx.request, env, WAITER);

    expect(drawerUpdateIn(boundParams)).toBeUndefined();
  });

  it('leaves the tally alone when nothing was paid in cash', async () => {
    const { env, boundParams } = makeEnv({ orderRows: [OPEN_ORDER] });
    const ctx = makeRequest('/api/orders/Otab0001', 'PUT', {
      status: 'served',
      total: 260,
      paymentBreakdown: [{ method: 'telebirr', amount: 260 }],
    });

    await handleOrders(ctx.pathname, ctx.method, ctx.url, ctx.request, env, WAITER);

    expect(drawerUpdateIn(boundParams)).toBeUndefined();
  });
});
