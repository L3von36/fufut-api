import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleOrders, resetOrderItemColumns } from '../src/handlers/orders.js';

/**
 * Regression tests for the second cashier mobile audit pass (2026-08-27 late).
 *
 * N1 — POST /api/orders/:id/split crashed with a 500 on every attempt: the
 *      INSERT named two columns (table_number, created_at) that do not exist
 *      on `orders`, so the Split Bill button on Open Checks had never once
 *      worked in production. The rewrite also retires the parent check as
 *      cancelled-with-reason (out of revenue, open checks and the boards,
 *      its money carried once by the split children) and makes the last
 *      share absorb the rounding remainder so the parts sum to the whole.
 */

function makeEnv({ orderRows = [], overrides = {} } = {}) {
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
            if (/FROM orders WHERE id = \?/.test(sql)) return { results: orderRows };
            if (/PRAGMA table_info\(orders\)/.test(sql)) {
              return {
                results: [
                  'id', 'items', 'total', 'payment', 'type', 'table_id',
                  'customer', 'status', 'email', 'notes', 'subtotal',
                  'discount', 'tip', 'payment_status', 'created_by',
                  'created_by_name', 'voided_at', 'void_reason',
                  'void_category', 'updated_at', 'created',
                ].map((name) => ({ name })),
              };
            }
            if (/PRAGMA table_info\(order_items\)/.test(sql)) {
              return {
                results: [
                  'id', 'order_id', 'line_no', 'menu_item_id', 'name',
                  'category', 'qty', 'unit_price', 'modifiers', 'notes',
                  'status', 'created_at', 'course',
                ].map((name) => ({ name })),
              };
            }
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

function makeRequest(pathAndQuery, method = 'GET', body = null) {
  const url = new URL('https://pos.fufutcoffee.com' + pathAndQuery);
  const req = new Request(url.toString(), {
    method,
    body: body ? JSON.stringify(body) : null,
    headers: { 'Content-Type': 'application/json' },
  });
  return { pathname: url.pathname, method, url, request: req };
}

const CASHIER = { staff_id: 'S7', sessionRole: 'cashier', firstName: 'Bethel' };

const OPEN_CHECK = {
  id: 'Oc9c99a0',
  items: '2xMacchiato',
  total: 260,
  tip: 0,
  type: 'dine-in',
  table_id: '5',
  customer: 'Mobile Audit',
  status: 'served',
  payment_status: 'unpaid',
  voided_at: null,
  created: '2026-08-27T19:00:00Z',
};

describe('N1: splitting an open check', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetOrderItemColumns();
  });

  it('creates the child checks and never names a column the table lacks', async () => {
    const { env, boundParams } = makeEnv({ orderRows: [OPEN_CHECK] });
    const ctx = makeRequest('/api/orders/Oc9c99a0/split', 'POST', { seatCount: 2 });

    const res = await handleOrders(ctx.pathname, ctx.method, ctx.url, ctx.request, env, CASHIER);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.splits).toHaveLength(2);

    const inserts = boundParams.filter((b) => /INSERT INTO orders/.test(b.sql));
    expect(inserts).toHaveLength(2);
    for (const ins of inserts) {
      expect(ins.sql).not.toMatch(/table_number/);
      expect(ins.sql).not.toMatch(/created_at/);
    }
  });

  it('splits ETB 260 two ways into 130 + 130 and three ways with the remainder on the last share', async () => {
    const { env } = makeEnv({ orderRows: [{ ...OPEN_CHECK, total: 100 }] });
    const ctx = makeRequest('/api/orders/Oc9c99a0/split', 'POST', { seatCount: 3 });
    const res = await handleOrders(ctx.pathname, ctx.method, ctx.url, ctx.request, env, CASHIER);
    const body = await res.json();
    const totals = body.splits.map((s) => s.total);
    // 100 / 3 = 33.33 each; the last share carries the extra cent.
    expect(totals[0]).toBe(33.33);
    expect(totals[1]).toBe(33.33);
    expect(totals[2]).toBe(33.34);
    expect(totals.reduce((s, v) => s + v, 0)).toBeCloseTo(100, 6);
  });

  it('retires the parent as cancelled with a reason, not fulfilled', async () => {
    const { env, boundParams } = makeEnv({ orderRows: [OPEN_CHECK] });
    const ctx = makeRequest('/api/orders/Oc9c99a0/split', 'POST', { seatCount: 2 });
    await handleOrders(ctx.pathname, ctx.method, ctx.url, ctx.request, env, CASHIER);

    const parentUpdate = boundParams.find(
      (b) => /UPDATE orders SET status = 'cancelled'/.test(b.sql) && /payment_status = 'split'/.test(b.sql)
    );
    expect(parentUpdate, 'parent must leave revenue and open checks as cancelled').toBeTruthy();
    expect(parentUpdate.sql).toMatch(/void_reason = \?/);
    expect(parentUpdate.sql).toMatch(/voided_at = \?/);
    expect(parentUpdate.params.some((p) => /Split into 2 checks/.test(String(p)))).toBe(true);
  });

  it('refuses to split an already-settled check', async () => {
    const { env } = makeEnv({ orderRows: [{ ...OPEN_CHECK, payment_status: 'paid' }] });
    const ctx = makeRequest('/api/orders/Oc9c99a0/split', 'POST', { seatCount: 2 });
    const res = await handleOrders(ctx.pathname, ctx.method, ctx.url, ctx.request, env, CASHIER);
    expect(res.status).toBe(409);
  });

  it('refuses to split a voided check', async () => {
    const { env } = makeEnv({ orderRows: [{ ...OPEN_CHECK, voided_at: '2026-08-27T19:05:00Z' }] });
    const ctx = makeRequest('/api/orders/Oc9c99a0/split', 'POST', { seatCount: 2 });
    const res = await handleOrders(ctx.pathname, ctx.method, ctx.url, ctx.request, env, CASHIER);
    expect(res.status).toBe(409);
  });

  it('clamps the seat count into the 2..10 range the UI offers', async () => {
    const { env } = makeEnv({ orderRows: [OPEN_CHECK] });
    const ctx = makeRequest('/api/orders/Oc9c99a0/split', 'POST', { seatCount: '99' });
    const res = await handleOrders(ctx.pathname, ctx.method, ctx.url, ctx.request, env, CASHIER);
    const body = await res.json();
    expect(body.splits).toHaveLength(10);
  });
});
