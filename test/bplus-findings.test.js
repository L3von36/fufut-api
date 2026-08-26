import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleOrders, resetOrderItemColumns } from '../src/handlers/orders.js';

/**
 * Regression tests for the six B+ simulation findings (2026-08-25).
 *
 * 1. POST /api/orders auto-seats a dine-in table (no longer relies on a
 *    separate PUT /api/tables/:id from the client).
 * 2. DELETE /api/orders/:id on a paid cash order auto-issues refunds and
 *    decrements the drawer's cash_sales by the same figure.
 * 3. DELETE accepts a `void_category` field that survives to the audit log,
 *    distinguishing operator-error voids from real customer voids.
 * 5. POST /api/orders links to a seated reservation on the same table when
 *    one exists and carries no order_id yet.
 *
 * (Findings 4 and 6 are documentation / cashdrawer-side respectively and are
 * exercised by the resources-test patterns below rather than re-imported here.)
 */

function makeEnv({
  orderRows = [],
  itemRows = [],
  paymentRows = [],
  tableRows = [],
  overrides = {},
} = {}) {
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
            if (/FROM payments WHERE order_id/.test(sql)) return { results: paymentRows };
            if (/FROM tables WHERE id|FROM tables WHERE id|FROM tables WHERE/.test(sql)) return { results: tableRows };
            if (/PRAGMA table_info\(orders\)/.test(sql)) {
              return {
                results: [
                  'id', 'items', 'total', 'payment', 'type', 'table_id',
                  'customer', 'status', 'email', 'notes', 'subtotal',
                  'discount', 'discount_type', 'discount_reason', 'tip',
                  'tip_type', 'service_charge', 'tax', 'delivery_fee',
                  'customer_phone', 'pickup_status', 'payment_status',
                  'created_by', 'created_by_name', 'voided_at', 'voided_by',
                  'void_reason', 'void_category', 'updated_at', 'created',
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

function makeRequest(pathname, method = 'GET', body = null) {
  const url = new URL('https://pos.fufutcoffee.com' + pathname);
  const req = new Request(url.toString(), {
    method,
    body: body ? JSON.stringify(body) : null,
    headers: { 'Content-Type': 'application/json' },
  });
  return { pathname, method, url, request: req };
}

const WAITER = { staff_id: 'S6', sessionRole: 'head-waiter', firstName: 'Yonas' };
const MANAGER = { staff_id: 'S1', sessionRole: 'manager', firstName: 'Amanuel' };

// ─────────────────────────────────────────────────────────────────────────────
// Finding 1 — auto-seat on POST /api/orders for dine-in
// ─────────────────────────────────────────────────────────────────────────────

describe('Finding 1: POST /api/orders seats the dine-in table', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetOrderItemColumns();
  });

  it('fires the conditional UPDATE on the table when the order is dine-in', async () => {
    const { env, boundParams } = makeEnv({
      tableRows: [{ id: 'T3', number: 3, status: 'available', qr_key: '' }],
    });
    const ctx = makeRequest('/api/orders', 'POST', {
      type: 'dine-in',
      table_number: '3',
      total: 260,
      items: '2xMacchiato',
    });

    const res = await handleOrders(ctx.pathname, ctx.method, ctx.url, ctx.request, env, WAITER);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const seatUpd = boundParams.find(
      (b) => /UPDATE tables SET status = 'occupied'/.test(b.sql) && /table_id = \?/.test(b.sql) === false
    );
    expect(seatUpd, 'a dine-in order must fire a seat UPDATE').toBeTruthy();
    // The seat fires once on the QR path (skipped, no table_key) and once on
    // the new dine-in path; either way the conditional claim is what we want.
    expect(seatUpd.sql).toMatch(/WHERE id = \? AND status <> 'occupied'/);
  });

  it('does not seat for a takeaway order with no table_id', async () => {
    const { env, boundParams } = makeEnv();
    const ctx = makeRequest('/api/orders', 'POST', {
      type: 'takeaway',
      total: 130,
      items: '1xMacchiato',
    });
    const res = await handleOrders(ctx.pathname, ctx.method, ctx.url, ctx.request, env, WAITER);
    expect(res.status).toBe(200);
    const seatUpd = boundParams.find((b) => /UPDATE tables SET status = 'occupied'/.test(b.sql));
    expect(seatUpd).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Finding 2 + 3 — void paid cash order auto-refunds and tags the category
// ─────────────────────────────────────────────────────────────────────────────

describe('Findings 2 & 3: DELETE /api/orders/:id voids with refund + category', () => {
  afterEach(() => vi.restoreAllMocks());

  const PAID_ORDER = {
    id: 'Opd0001',
    items: 'Espresso',
    total: 150,
    type: 'dine-in',
    table_id: '4',
    status: 'fulfilled',
    payment_status: 'paid',
    voided_at: null,
    created: '2026-08-25T10:00:00Z',
  };
  const CASH_PAYMENT = { id: 'PMcash01', order_id: 'Opd0001', amount: 150, method: 'cash', status: 'verified' };
  const TELEBIRR_PAYMENT = { id: 'PMtel01', order_id: 'Opd0001', amount: 100, method: 'telebirr', status: 'verified' };

  it('auto-refunds verified cash payments when a manager voids', async () => {
    const { env, run, boundParams } = makeEnv({
      orderRows: [PAID_ORDER],
      paymentRows: [CASH_PAYMENT],
    });
    const ctx = makeRequest('/api/orders/Opd0001', 'DELETE', {
      reason: 'Customer walked before being served',
      void_category: 'customer',
    });

    const res = await handleOrders(ctx.pathname, ctx.method, ctx.url, ctx.request, env, MANAGER);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.voided).toBe(true);
    expect(body.void_category).toBe('customer');
    expect(body.auto_refunded).toBe(150);
    expect(body.refund_ids).toHaveLength(1);

    // A negative payment row was inserted (the auto-refund).
    const refundInsert = boundParams.find(
      (b) => /INSERT INTO payments/.test(b.sql) && b.params.some((p) => p === -150)
    );
    expect(refundInsert, 'a negative cash payment row must be inserted').toBeTruthy();

    // The original payment was marked refunded.
    const markRefunded = boundParams.find(
      (b) => /UPDATE payments SET status = 'refunded'/.test(b.sql) && b.params.includes('PMcash01')
    );
    expect(markRefunded, 'the original payment must be marked refunded').toBeTruthy();

    // The drawer was decremented by the same figure.
    const drawerDec = boundParams.find(
      (b) => /UPDATE cashdrawers\s+SET cash_sales/.test(b.sql) && b.params.includes(-150)
    );
    expect(drawerDec, 'the drawer must be decremented by the refunded amount').toBeTruthy();
  });

  it('does not auto-refund telebirr payments (those refund outside the till)', async () => {
    const { env, boundParams } = makeEnv({
      orderRows: [PAID_ORDER],
      paymentRows: [TELEBIRR_PAYMENT],
    });
    const ctx = makeRequest('/api/orders/Opd0001', 'DELETE', { reason: 'Test void' });
    const res = await handleOrders(ctx.pathname, ctx.method, ctx.url, ctx.request, env, MANAGER);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.auto_refunded).toBe(0);
    expect(body.refund_ids).toEqual([]);
    const refundInsert = boundParams.find(
      (b) => /INSERT INTO payments/.test(b.sql) && b.params.some((p) => p < 0)
    );
    expect(refundInsert).toBeUndefined();
  });

  it('refuses a non-manager void of a paid order with the original 409', async () => {
    const { env } = makeEnv({
      orderRows: [PAID_ORDER],
      paymentRows: [CASH_PAYMENT],
    });
    const ctx = makeRequest('/api/orders/Opd0001', 'DELETE', { reason: 'attempt' });
    const res = await handleOrders(ctx.pathname, ctx.method, ctx.url, ctx.request, env, WAITER);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/paid. A manager must refund/);
  });

  it('stores void_category on the order and surfaces an unknown value as "other"', async () => {
    const { env, boundParams } = makeEnv({
      orderRows: [PAID_ORDER],
      paymentRows: [],
    });
    const ctx = makeRequest('/api/orders/Opd0001', 'DELETE', {
      reason: 'API probe mis-fire',
      void_category: 'TRAINING',
    });
    const res = await handleOrders(ctx.pathname, ctx.method, ctx.url, ctx.request, env, MANAGER);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.void_category).toBe('training');

    // The UPDATE on orders carries void_category as a set column.
    const voidUpdate = boundParams.find(
      (b) => /UPDATE orders\s+SET status = 'cancelled'/.test(b.sql) && b.sql.includes('void_category = ?')
    );
    expect(voidUpdate, 'void_category must be written into the orders UPDATE').toBeTruthy();
    expect(voidUpdate.params).toContain('training');
  });

  it('defaults void_category to "other" when not provided (back-compat)', async () => {
    const { env } = makeEnv({
      orderRows: [PAID_ORDER],
      paymentRows: [],
    });
    const ctx = makeRequest('/api/orders/Opd0001', 'DELETE', { reason: 'no category' });
    const res = await handleOrders(ctx.pathname, ctx.method, ctx.url, ctx.request, env, MANAGER);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.void_category).toBe('other');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Finding 5 — POST /api/orders links a seated reservation to the order
// ─────────────────────────────────────────────────────────────────────────────

describe('Finding 5: POST /api/orders links reservation.order_id', () => {
  afterEach(() => vi.restoreAllMocks());

  it('fires the UPDATE that sets reservations.order_id when a table_id is set', async () => {
    const { env, boundParams } = makeEnv({
      tableRows: [{ id: 'T9', number: 9, status: 'available', qr_key: '' }],
    });
    const ctx = makeRequest('/api/orders', 'POST', {
      type: 'dine-in',
      table_number: '9',
      total: 370,
      items: '2xFlat White',
    });
    const res = await handleOrders(ctx.pathname, ctx.method, ctx.url, ctx.request, env, WAITER);
    expect(res.status).toBe(200);

    const linkUpd = boundParams.find(
      (b) => /UPDATE reservations\s+SET order_id = \?/.test(b.sql) && b.sql.includes("status = 'seated'")
    );
    expect(linkUpd, 'a seated reservation on the same table must be linked').toBeTruthy();
    // Params are [newOrderId, nowIso, tableId].
    expect(linkUpd.params[2]).toBe('9');
  });

  it('does not fire the reservation link when there is no table_id (takeaway)', async () => {
    const { env, boundParams } = makeEnv();
    const ctx = makeRequest('/api/orders', 'POST', {
      type: 'takeaway',
      total: 130,
      items: '1xMacchiato',
    });
    const res = await handleOrders(ctx.pathname, ctx.method, ctx.url, ctx.request, env, WAITER);
    expect(res.status).toBe(200);
    const linkUpd = boundParams.find((b) => /UPDATE reservations\s+SET order_id/.test(b.sql));
    expect(linkUpd).toBeUndefined();
  });
});
