import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleOrders, resetOrderItemColumns } from '../src/handlers/orders.js';
import { handlePayments } from '../src/handlers/payments.js';
import { handleReports } from '../src/handlers/reports.js';

/**
 * Regression tests for the cashier mobile audit (2026-08-27).
 *
 * C3 — voiding a paid cash order auto-refunds the whole payment, tip
 *      included, so the order's tips rows must flip to 'refunded' and the
 *      dashboard/P&L tips sums must stop counting refunded tips.
 * C8 — GET /api/payments?verified=false used to be ignored (every payment of
 *      every status came back), which made the cashier dashboard render a
 *      Verify button on settled cash and on refunds.
 */

function makeEnv({ orderRows = [], itemRows = [], paymentRows = [], overrides = {} } = {}) {
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
            if (/PRAGMA table_info\(orders\)/.test(sql)) {
              return {
                results: [
                  'id', 'items', 'total', 'payment', 'type', 'table_id',
                  'customer', 'status', 'email', 'notes', 'subtotal',
                  'discount', 'tip', 'payment_status', 'created_by',
                  'created_by_name', 'voided_at', 'void_by', 'void_reason',
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
  // Route matching happens on the bare path — the query string lives on `url`.
  return { pathname: url.pathname, method, url, request: req };
}

const MANAGER = { staff_id: 'S1', sessionRole: 'manager', firstName: 'Amanuel' };
const CASHIER = { staff_id: 'S7', sessionRole: 'cashier', firstName: 'Bethel' };

// ─────────────────────────────────────────────────────────────────────────────
// C3 — void flips the order's tips to refunded
// ─────────────────────────────────────────────────────────────────────────────

describe('C3: voiding a paid cash order refunds the tip with it', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetOrderItemColumns();
  });

  const PAID_ORDER = {
    id: 'Otip0001',
    items: '2xMacchiato',
    total: 226,           // 205 food + 21 tip
    tip: 21,
    type: 'dine-in',
    table_id: '5',
    status: 'served',
    payment_status: 'paid',
    voided_at: null,
    created: '2026-08-27T16:00:00Z',
  };
  const CASH_PAYMENT = { id: 'PMcashT1', order_id: 'Otip0001', amount: 226, method: 'cash', status: 'verified' };
  const TELEBIRR_PAYMENT = { id: 'PMtelT1', order_id: 'Otip0001', amount: 226, method: 'telebirr', status: 'verified' };

  it('marks the order\'s tips refunded when the cash auto-refund fires', async () => {
    const { env, boundParams } = makeEnv({
      orderRows: [PAID_ORDER],
      paymentRows: [CASH_PAYMENT],
    });
    const ctx = makeRequest('/api/orders/Otip0001', 'DELETE', { reason: 'training', void_category: 'training' });

    const res = await handleOrders(ctx.pathname, ctx.method, ctx.url, ctx.request, env, MANAGER);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.auto_refunded).toBe(226);

    const tipsFlip = boundParams.find(
      (b) => /UPDATE tips SET status = 'refunded'/.test(b.sql)
    );
    expect(tipsFlip, 'the tips rows must be flipped to refunded').toBeTruthy();
    expect(tipsFlip.params).toContain('Otip0001');
    expect(tipsFlip.sql).toMatch(/status <> 'refunded'/);
  });

  it('leaves tips alone when no cash auto-refund fires (telebirr settles outside)', async () => {
    const { env, boundParams } = makeEnv({
      orderRows: [PAID_ORDER],
      paymentRows: [TELEBIRR_PAYMENT],
    });
    const ctx = makeRequest('/api/orders/Otip0001', 'DELETE', { reason: 'training' });

    const res = await handleOrders(ctx.pathname, ctx.method, ctx.url, ctx.request, env, MANAGER);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.auto_refunded).toBe(0);

    const tipsFlip = boundParams.find(
      (b) => /UPDATE tips SET status = 'refunded'/.test(b.sql)
    );
    expect(tipsFlip).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C3 — reporting sums exclude refunded tips
// ─────────────────────────────────────────────────────────────────────────────

describe('C3: dashboard and P&L tips sums exclude refunded tips', () => {
  afterEach(() => vi.restoreAllMocks());

  it('filters refunded tips out of the dashboard tips figure', async () => {
    const { env, boundParams } = makeEnv();
    const ctx = makeRequest('/api/reports/dashboard?period=day');
    const res = await handleReports(ctx.pathname, ctx.method, ctx.url, ctx.request, env, CASHIER);
    expect(res.status).toBe(200);

    const tipsQuery = boundParams.find(
      (b) => /FROM tips/.test(b.sql) && /SUM\(amount\)/.test(b.sql)
    );
    expect(tipsQuery, 'a tips sum must run').toBeTruthy();
    expect(tipsQuery.sql).toMatch(/COALESCE\(status, 'recorded'\) <> 'refunded'/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C8 — GET /api/payments honours ?verified=
// ─────────────────────────────────────────────────────────────────────────────

describe('C8: GET /api/payments honours the verified filter', () => {
  afterEach(() => vi.restoreAllMocks());

  const RECORDED = [{ id: 'PMrec1', order_id: 'O1', amount: 100, method: 'telebirr', status: 'recorded' }];
  const VERIFIED = [{ id: 'PMver1', order_id: 'O2', amount: 50, method: 'cash', status: 'verified' }];

  function paymentsEnv(overrides = {}) {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 1 }, results: [] });
    const boundParams = [];
    const prepare = vi.fn(function (sql) {
      return {
        bind: (...params) => {
          boundParams.push({ sql, params });
          return {
            all: async () => {
              for (const [frag, result] of Object.entries(overrides)) {
                if (sql.includes(frag)) return { results: result };
              }
              return { results: [] };
            },
            run,
          };
        },
      };
    });
    return { env: { DB: { prepare } }, boundParams };
  }

  it('?verified=false selects only recorded (pending) payments', async () => {
    const { env, boundParams } = paymentsEnv({ 'WHERE status': RECORDED });
    const ctx = makeRequest('/api/payments?verified=false');
    const res = await handlePayments(ctx.pathname, ctx.method, ctx.url, ctx.request, env, CASHIER);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].status).toBe('recorded');
    expect(boundParams[0].sql).toMatch(/WHERE status = 'recorded'/);
  });

  it('?verified=true selects only verified payments', async () => {
    const { env, boundParams } = paymentsEnv({ 'WHERE status': VERIFIED });
    const ctx = makeRequest('/api/payments?verified=true');
    const res = await handlePayments(ctx.pathname, ctx.method, ctx.url, ctx.request, env, CASHIER);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0].status).toBe('verified');
    expect(boundParams[0].sql).toMatch(/WHERE status = 'verified'/);
  });

  it('without the parameter the listing stays unfiltered (back-compat)', async () => {
    const { env, boundParams } = paymentsEnv();
    const ctx = makeRequest('/api/payments');
    const res = await handlePayments(ctx.pathname, ctx.method, ctx.url, ctx.request, env, CASHIER);
    expect(res.status).toBe(200);
    expect(boundParams[0].sql).not.toMatch(/WHERE status/);
    expect(boundParams[0].sql).toMatch(/LIMIT 500/);
  });
});
