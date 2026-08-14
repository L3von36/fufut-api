import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleOrders } from '../src/handlers/orders.js';

/**
 * Minimal D1 fake: prepare().bind().all() and .run() return canned results,
 * keyed by the SQL being executed. This lets us exercise the route-matching
 * logic in handleOrders without a real database.
 */
function makeEnv({ orderRows = [], itemRows = [] } = {}) {
  const run = vi.fn().mockResolvedValue({ meta: { changes: 1 }, results: [] });
  const all = vi.fn();
  const prepare = vi.fn(function (sql) {
    return {
      bind: () => ({
        all: async () => {
          if (/FROM orders WHERE id/.test(sql)) return { results: orderRows };
          if (/FROM order_items/.test(sql)) return { results: itemRows };
          if (/^SELECT/.test(sql)) return { results: [] };
          throw new Error('Unexpected SQL in test: ' + sql);
        },
        run,
      }),
    };
  });
  return { env: { DB: { prepare } }, prepare, run };
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

const ORDER = {
  id: 'Otest01', items: '[]', total: 660, payment: null, type: 'dine-in',
  table_id: '3', customer: 'Test', status: 'new', created: '2026-08-14T00:00:00',
};

const LINE = {
  id: 'OI1', order_id: 'Otest01', line_no: 1, name: 'Macchiato', qty: 1,
  unit_price: 130, category: 'Coffee', status: 'new',
};

describe('GET /api/orders/:id', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns the order with its items attached', async () => {
    const { env, prepare } = makeEnv({ orderRows: [ORDER], itemRows: [LINE] });
    const { pathname, method, url, request } = makeRequest('/api/orders/Otest01');
    const res = await handleOrders(pathname, method, url, request, env, { staff_id: 'S1' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe('Otest01');
    expect(body.tableNum).toBe('3');
    expect(body.items).toHaveLength(1);
    expect(body.items[0].name).toBe('Macchiato');
    expect(prepare.mock.calls.some((c) => /FROM order_items/.test(c[0]))).toBe(true);
  });

  it('returns 404 for an unknown order', async () => {
    const { env } = makeEnv({ orderRows: [] });
    const { pathname, method, url, request } = makeRequest('/api/orders/Omissing');
    const res = await handleOrders(pathname, method, url, request, env, { staff_id: 'S1' });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Order not found');
  });

  it('does not shadow the /:id/items route', async () => {
    const { env } = makeEnv({ itemRows: [LINE] });
    const { pathname, method, url, request } = makeRequest('/api/orders/Otest01/items');
    const res = await handleOrders(pathname, method, url, request, env, { staff_id: 'S1' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });
});
