import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { handleOrders, resetOrderColumns } from '../src/handlers/orders.js';
import { normaliseLines } from '../src/lib/timing.js';

/**
 * D1 fake extended for open-tabs tests.
 * Supports SELECT, INSERT (batch), UPDATE, and configurable per-SQL routing.
 */
function makeEnv({
  orderRows = [],
  itemRows = [],
  maxLine = 0,
  existingTips = [],
  orderColumns = ['id','items','total','subtotal','discount','tip','tax','service_charge','delivery_fee','payment_status','updated_at'],
} = {}) {
  const runLog = [];
  const allLog = [];

  const run = vi.fn().mockResolvedValue({ meta: { changes: 1 }, results: [] });

  const all = vi.fn();
  const prepare = vi.fn(function (sql) {
    return {
      bind: (...args) => ({
        all: async () => {
          allLog.push({ sql, args });
          if (/PRAGMA table_info/.test(sql)) {
            return { results: orderColumns.map(c => ({ name: c })) };
          }
          if (/FROM orders WHERE id/.test(sql) && !/order_items/.test(sql)) return { results: orderRows };
          if (/FROM order_items/.test(sql) && /MAX\(line_no\)/.test(sql)) {
            return { results: [{ max_line: maxLine }] };
          }
          if (/FROM order_items/.test(sql)) return { results: itemRows };
          if (/FROM tips WHERE order_id/.test(sql)) return { results: existingTips };
          if (/^SELECT/.test(sql)) return { results: [] };
          throw new Error('Unexpected SELECT in test: ' + sql);
        },
        run: async () => {
          runLog.push({ sql, args });
          return { meta: { changes: 1 } };
        },
      }),
    };
  });

  // env.DB.batch() is called directly by insertOrderItems
  const batch = vi.fn(async (stmts) => {
    for (const s of stmts) {
      runLog.push({ sql: s._sql || 'batch-stmt', batch: true });
    }
    return { meta: { changes: stmts.length } };
  });

  return { env: { DB: { prepare, batch } }, prepare, run, runLog, allLog };
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
  type: 'dine-in', table_id: '3', customer: 'Test', status: 'new',
  payment_status: 'unpaid', subtotal: 130, discount: 0, tip: 0,
  delivery_fee: 0, service_charge: 0, tax: 0,
  created: '2026-08-14T00:00:00', updated_at: '2026-08-14T00:00:00',
};

const COMPLETED_ORDER = {
  ...OPEN_ORDER,
  id: 'Odone01', status: 'completed',
};

const VOIDED_ORDER = {
  ...OPEN_ORDER,
  id: 'Ovoid01', status: 'cancelled', voided_at: '2026-08-14T01:00:00',
};

const NEW_ITEMS = [
  { name: 'Latte', basePrice: 100, qty: 2, menuItemId: 'M002', course: 'main' },
  { name: 'Cheesecake', basePrice: 150, qty: 1, menuItemId: 'M003', course: 'dessert' },
];

describe('Open Tabs — normaliseLines', () => {
  it('assigns lineNo = index + lineOffset', () => {
    const lines = normaliseLines(NEW_ITEMS, 5);
    expect(lines).toHaveLength(2);
    expect(lines[0].lineNo).toBe(5);
    expect(lines[1].lineNo).toBe(6);
  });

  it('defaults course to "main"', () => {
    const lines = normaliseLines([{ name: 'Espresso', basePrice: 50, qty: 1 }]);
    expect(lines[0].course).toBe('main');
  });

  it('preserves an explicit course', () => {
    const lines = normaliseLines([{ name: 'Soup', basePrice: 80, qty: 1, course: 'starters' }]);
    expect(lines[0].course).toBe('starters');
  });
});

describe('PATCH /api/orders/:id/items', () => {
  beforeEach(() => { resetOrderColumns(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('appends items and recomputes the bill', async () => {
    // itemRows must include BOTH existing and newly-inserted lines,
    // because the mock doesn't persist batch inserts.
    const { env, runLog, allLog } = makeEnv({
      orderRows: [OPEN_ORDER],
      itemRows: [
        { order_id: 'Oopen01', line_no: 0, name: 'Macchiato', unit_price: 130, qty: 1, status: 'new' },
        { order_id: 'Oopen01', line_no: 1, name: 'Latte', unit_price: 100, qty: 2, status: 'new' },
        { order_id: 'Oopen01', line_no: 2, name: 'Cheesecake', unit_price: 150, qty: 1, status: 'new' },
      ],
      maxLine: 0,
    });
    const { pathname, method, url, request } = makeRequest(
      '/api/orders/Oopen01/items', 'PATCH',
      { orderItems: NEW_ITEMS }
    );
    const res = await handleOrders(pathname, method, url, request, env, { staff_id: 'S1' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.itemsAppended).toBe(2);
    // Existing: 1x130=130. New: 2x100 + 1x150 = 350. Subtotal = 480.
    expect(body.subtotal).toBe(480);
    expect(body.total).toBe(480);
  });

  it('returns 404 for unknown order', async () => {
    const { env } = makeEnv({ orderRows: [] });
    const { pathname, method, url, request } = makeRequest(
      '/api/orders/Omissing/items', 'PATCH',
      { orderItems: NEW_ITEMS }
    );
    const res = await handleOrders(pathname, method, url, request, env, { staff_id: 'S1' });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Order not found');
  });

  it('returns 409 for completed order', async () => {
    const { env } = makeEnv({ orderRows: [COMPLETED_ORDER] });
    const { pathname, method, url, request } = makeRequest(
      '/api/orders/Odone01/items', 'PATCH',
      { orderItems: NEW_ITEMS }
    );
    const res = await handleOrders(pathname, method, url, request, env, { staff_id: 'S1' });
    expect(res.status).toBe(409);
  });

  it('returns 409 for voided order', async () => {
    const { env } = makeEnv({ orderRows: [VOIDED_ORDER] });
    const { pathname, method, url, request } = makeRequest(
      '/api/orders/Ovoid01/items', 'PATCH',
      { orderItems: NEW_ITEMS }
    );
    const res = await handleOrders(pathname, method, url, request, env, { staff_id: 'S1' });
    expect(res.status).toBe(409);
  });

  it('returns 400 for empty items array', async () => {
    const { env } = makeEnv({ orderRows: [OPEN_ORDER] });
    const { pathname, method, url, request } = makeRequest(
      '/api/orders/Oopen01/items', 'PATCH',
      { orderItems: [] }
    );
    const res = await handleOrders(pathname, method, url, request, env, { staff_id: 'S1' });
    expect(res.status).toBe(400);
  });
});

describe('PUT settlement (idempotency)', () => {
  beforeEach(() => { resetOrderColumns(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('does not INSERT a tip on retry (idempotency guard)', async () => {
    // First call: no existing tip → INSERT happens
    // Second call: existing tip → INSERT skipped
    const { env, allLog } = makeEnv({
      orderRows: [OPEN_ORDER],
      existingTips: [{ id: 'TPexisting', order_id: 'Oopen01' }],
    });

    const { pathname, method, url, request } = makeRequest(
      '/api/orders/Oopen01', 'PUT',
      { tip: 50, paymentBreakdown: [{ method: 'cash', amount: 180 }] }
    );
    const res = await handleOrders(pathname, method, url, request, env, { staff_id: 'S1' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // The tip guard should have found the existing row and skipped the INSERT.
    // Verify no INSERT INTO tips was attempted.
    const tipInserts = allLog.filter(
      (l) => typeof l.sql === 'string' && l.sql.includes('INSERT INTO tips')
    );
    expect(tipInserts).toHaveLength(0);
  });
});
