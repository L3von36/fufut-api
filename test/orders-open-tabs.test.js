import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleOrders, resetOrderItemColumns } from '../src/handlers/orders.js';
import { normaliseLines } from '../src/lib/timing.js';

/**
 * D1 fake driven by canned result-sets, keyed by the shape of the SQL. This
 * mirrors orders-single.test.js and extends it for the open-tab flow: the PATCH
 * append-round route needs to read the order, read the max line_no, insert new
 * lines, re-read all lines to recompute the bill, and update the order.
 *
 * `overrides` maps a SQL fragment to a canned `{ results }`, checked before the
 * defaults; tests use it to change one query at a time (e.g. simulate a payment
 * row already existing). `bind` params are recorded in `boundParams` so tests
 * can assert the values handed to a statement (e.g. the appended line_no).
 */
function makeEnv({ orderRows = [], itemRows = [], maxLineNo = null, overrides = {} } = {}) {
  const run = vi.fn().mockResolvedValue({ meta: { changes: 1 }, results: [] });
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
            if (/MAX\(line_no\)/.test(sql)) return { results: [{ maxLineNo }] };
            if (/FROM orders WHERE id/.test(sql)) return { results: orderRows };
            if (/PRAGMA table_info\(order_items\)/.test(sql)) {
              return { results: [{ name: 'course' }, { name: 'id' }] };
            }
            if (/FROM order_items/.test(sql)) return { results: itemRows };
            return { results: [] };
          },
          run,
        };
      },
    };
  });
  const env = {
    DB: {
      prepare,
      batch: vi.fn().mockResolvedValue([]),
    },
  };
  return { env, prepare, run, boundParams };
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

const OPEN_ORDER = {
  id: 'Oopen01', items: '1xMacchiato', total: 130, payment: null,
  type: 'dine-in', table_id: '3', status: 'new', subtotal: 130,
  tip: 0, discount: 0, service_charge: 0, tax: 0, delivery_fee: 0,
  created: '2026-08-14T00:00:00',
};

const EXISTING_LINE = {
  id: 'OI1', order_id: 'Oopen01', line_no: 0, name: 'Macchiato',
  qty: 1, unit_price: 130, category: 'Coffee', status: 'new',
};

describe('normaliseLines lineOffset and course', () => {
  it('continues line numbering where the last round left off', () => {
    const lines = normaliseLines([{ name: 'Tea' }, { name: 'Espresso' }], 3);
    expect(lines.map((l) => l.lineNo)).toEqual([3, 4]);
  });

  it('defaults lineOffset to zero so single orders still start at 0', () => {
    expect(normaliseLines([{ name: 'Tea' }])[0].lineNo).toBe(0);
  });

  it('carries the course a line belongs to', () => {
    const lines = normaliseLines([{ name: 'Gebeta', course: 'starters' }]);
    expect(lines[0].course).toBe('starters');
  });

  it('defaults to the main course when none is given', () => {
    expect(normaliseLines([{ name: 'Coffee' }])[0].course).toBe('main');
  });
});

describe('PATCH /api/orders/:id/items (append a round)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetOrderItemColumns();
  });

  it('appends lines with the next line numbers', async () => {
    const { env, prepare, boundParams } = makeEnv({
      orderRows: [OPEN_ORDER],
      itemRows: [EXISTING_LINE],
      maxLineNo: 0,
    });
    const body = {
      items: '1xTea',
      orderItems: [{ name: 'Tea', basePrice: 70, qty: 1 }],
    };
    const { pathname, method, url, request } = makeRequest('/api/orders/Oopen01/items', 'PATCH', body);
    const res = await handleOrders(pathname, method, url, request, env, { staff_id: 'S1' });
    expect(res.status).toBe(200);
    const parsed = await res.json();
    expect(parsed.ok).toBe(true);
    expect(parsed.items).toBe(1);

    // The insert must use lineOffset 1 (0 was taken), so the new line lands on
    // line_no 1 rather than colliding with the existing line.
    const insert = boundParams.find((b) => /INSERT INTO order_items/.test(b.sql));
    expect(insert).toBeTruthy();
    expect(insert.params).toContain('Oopen01');
    // Column order: id, order_id, line_no, menu_item_id, name, ...
    expect(insert.params[2]).toBe(1);
    expect(insert.params[2]).not.toBe(0);
  });

  it('recomputes the running bill from every line on the order', async () => {
    const { env, run } = makeEnv({
      orderRows: [OPEN_ORDER],
      itemRows: [
        EXISTING_LINE,
        { id: 'OI2', order_id: 'Oopen01', line_no: 1, name: 'Tea', qty: 1, unit_price: 70, status: 'new' },
      ],
      maxLineNo: 0,
    });
    const body = { items: '1xTea', orderItems: [{ name: 'Tea', basePrice: 70 }] };
    const { pathname, method, url, request } = makeRequest('/api/orders/Oopen01/items', 'PATCH', body);
    const res = await handleOrders(pathname, method, url, request, env, { staff_id: 'S1' });
    const parsed = await res.json();
    // 130 (macchiato) + 70 (tea) — the bill follows the food, not what the
    // client happened to send.
    expect(parsed.total).toBe(200);
    expect(parsed.subtotal).toBe(200);
  });

  it('returns 404 when the order does not exist', async () => {
    const { env } = makeEnv({ orderRows: [] });
    const body = { orderItems: [{ name: 'Tea', basePrice: 70 }] };
    const { pathname, method, url, request } = makeRequest('/api/orders/Omissing/items', 'PATCH', body);
    const res = await handleOrders(pathname, method, url, request, env, { staff_id: 'S1' });
    expect(res.status).toBe(404);
  });

  it('refuses to append to a completed or voided order', async () => {
    const completed = { ...OPEN_ORDER, status: 'completed' };
    const { env } = makeEnv({ orderRows: [completed], maxLineNo: 0 });
    const body = { orderItems: [{ name: 'Tea', basePrice: 70 }] };
    const { pathname, method, url, request } = makeRequest('/api/orders/Oopen01/items', 'PATCH', body);
    const res = await handleOrders(pathname, method, url, request, env, { staff_id: 'S1' });
    expect(res.status).toBe(409);
  });
});

describe('settlement payment idempotency (open tab)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetOrderItemColumns();
  });

  it('does not post the same cash twice when a PUT is retried', async () => {
    // First attempt: no existing payments, so the INSERT runs.
    const first = makeEnv({ orderRows: [OPEN_ORDER] });
    const payload = {
      total: 660,
      tip: 60,
      paymentBreakdown: [{ method: 'cash', amount: 660 }],
      payment: 'cash',
    };
    const req1 = makeRequest('/api/orders/Oopen01', 'PUT', payload);
    await handleOrders(req1.pathname, req1.method, req1.url, req1.request, first.env, { staff_id: 'S1' });
    const insertsFirst = first.prepare.mock.calls.filter((c) => /INSERT INTO payments/.test(c[0]));
    expect(insertsFirst.length).toBeGreaterThan(0);

    // Second attempt (the retry): a payment row now exists, so the insert must
    // be skipped entirely.
    const second = makeEnv({
      orderRows: [OPEN_ORDER],
      overrides: { 'SELECT id FROM payments': { results: [{ id: 'PM123' }] } },
    });
    const req2 = makeRequest('/api/orders/Oopen01', 'PUT', payload);
    const res2 = await handleOrders(req2.pathname, req2.method, req2.url, req2.request, second.env, { staff_id: 'S1' });
    expect(res2.status).toBe(200);
    const insertsSecond = second.prepare.mock.calls.filter((c) => /INSERT INTO payments/.test(c[0]));
    expect(insertsSecond.length).toBe(0);
  });
});
