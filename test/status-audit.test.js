import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleOrders, resetOrderItemColumns } from '../src/handlers/orders.js';

/**
 * The per-person performance trail (2026-09-25).
 *
 * The team analytics read stage transitions out of the audit log
 * (action 'status'). Two routes move tickets through stages:
 *
 *   * PUT /api/orders/:orderId/items/:itemId — every board tap (the chef's
 *     "preparing", the barista's "ready") — which until now wrote NOTHING,
 *     so the kitchen's work was invisible to the per-person numbers;
 *   * PUT /api/orders/:id — the floor's pickup and serve, whose
 *     station-scoped path derived the order status from its lines and left
 *     the audit diff empty, which writeAudit drops silently.
 *
 * Both now land one attributable 'status' row per transition; a re-tap that
 * does not move the line still writes nothing.
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
  return { pathname: url.pathname, method, url, request: req };
}

const MANAGER = { staff_id: 'S1', sessionRole: 'manager', firstName: 'Amanuel' };
const BARISTA = { staff_id: 'S4', sessionRole: 'barista', firstName: 'Selam' };

const flush = () => new Promise((r) => setTimeout(r, 10));
const auditRows = (boundParams) =>
  boundParams
    .filter((b) => /INSERT INTO audit_log/.test(b.sql))
    .map((b) => ({
      action: b.params[5],
      entity: b.params[6],
      entityId: b.params[7],
      before: JSON.parse(b.params[8] || '{}'),
      after: JSON.parse(b.params[9] || '{}'),
    }));

const ORDER = {
  id: 'Ostage001',
  status: 'preparing',
  type: 'dine-in',
  total: 120,
  voided_at: null,
  created: '2026-09-25 10:00:00',
};

const DRINK_LINE = {
  id: 'I2',
  order_id: 'Ostage001',
  category: 'Drinks',
  name: 'Latte',
  status: 'preparing',
};

afterEach(() => resetOrderItemColumns());

describe('per-line stage audit (the boards\' route)', () => {
  it('writes a status row with the actor when a line advances', async () => {
    const { env, boundParams } = makeEnv({
      orderRows: [ORDER],
      itemRows: [DRINK_LINE],
      overrides: {
        // The rollup read sees every line already ready → order rolls too.
        'SELECT status FROM order_items WHERE order_id': {
          results: [{ status: 'ready' }, { status: 'ready' }],
        },
      },
    });
    const ctx = makeRequest('/api/orders/Ostage001/items/I2', 'PUT', { status: 'ready' });

    const res = await handleOrders(ctx.pathname, ctx.method, ctx.url, ctx.request, env, BARISTA);
    expect(res.status).toBe(200);
    await flush();

    const rows = auditRows(boundParams).filter((r) => r.action === 'status');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[0];
    expect(row.entity).toBe('orders');
    expect(row.entityId).toBe('Ostage001');
    expect(row.before.lineStatus).toBe('preparing');
    expect(row.after.lineStatus).toBe('ready');
    // The actor fields land in the INSERT params: staff S4 (Selam, barista).
    const insert = boundParams.find((b) => /INSERT INTO audit_log/.test(b.sql));
    expect(insert.params[2]).toBe('S4');
    expect(insert.params[6]).toBe('orders');
  });

  it('writes nothing when the tap does not move the line', async () => {
    const readyLine = { ...DRINK_LINE, status: 'ready' };
    const { env, boundParams } = makeEnv({
      orderRows: [{ ...ORDER, status: 'ready' }],
      itemRows: [readyLine],
    });
    const ctx = makeRequest('/api/orders/Ostage001/items/I2', 'PUT', { status: 'ready' });

    const res = await handleOrders(ctx.pathname, ctx.method, ctx.url, ctx.request, env, BARISTA);
    expect(res.status).toBe(200);
    await flush();

    expect(auditRows(boundParams)).toHaveLength(0);
  });
});

describe('whole-order stage audit', () => {
  it('the floor\'s serve lands as a status row (verbatim path)', async () => {
    const { env, boundParams } = makeEnv({ orderRows: [ORDER] });
    const ctx = makeRequest('/api/orders/Ostage001', 'PUT', { status: 'served' });

    const res = await handleOrders(ctx.pathname, ctx.method, ctx.url, ctx.request, env, MANAGER);
    expect(res.status).toBe(200);
    await flush();

    const rows = auditRows(boundParams).filter((r) => r.action === 'status');
    expect(rows).toHaveLength(1);
    expect(rows[0].after.status).toBe('served');
  });

  it('a station-scoped handoff keeps its derived status in the trail', async () => {
    // The barista PUTs fulfilled on a whole ticket whose lines are all
    // ready: the verbatim write is skipped, the lines move to served, the
    // order's status is derived — and the audit row must still carry it
    // (plus the station), not vanish. The mock's rollup read returns the
    // post-update line states, which is what the derive actually sees.
    const { env, boundParams } = makeEnv({
      orderRows: [{ ...ORDER, status: 'ready' }],
      itemRows: [{ ...DRINK_LINE, status: 'ready' }],
      overrides: {
        'SELECT status FROM order_items WHERE order_id': {
          results: [{ status: 'served' }, { status: 'served' }],
        },
      },
    });
    const ctx = makeRequest('/api/orders/Ostage001', 'PUT', { status: 'fulfilled' });

    const res = await handleOrders(ctx.pathname, ctx.method, ctx.url, ctx.request, env, BARISTA);
    expect(res.status).toBe(200);
    await flush();

    const rows = auditRows(boundParams).filter((r) => r.action === 'status');
    expect(rows).toHaveLength(1);
    expect(rows[0].after.status).toBe('fulfilled'); // kept, not collapsed to 'served'
    expect(rows[0].after.station).toBe('bar');
  });

  it('a plain edit stays an update row', async () => {
    const { env, boundParams } = makeEnv({ orderRows: [ORDER] });
    const ctx = makeRequest('/api/orders/Ostage001', 'PUT', { customer: 'Hanna' });

    const res = await handleOrders(ctx.pathname, ctx.method, ctx.url, ctx.request, env, MANAGER);
    expect(res.status).toBe(200);
    await flush();

    const rows = auditRows(boundParams);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('update');
  });
});
