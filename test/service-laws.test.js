import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleOrders } from '../src/handlers/orders.js';
import { tickChannel, kitchenEventName, clearChannelCacheForTest } from '../src/handlers/sse.js';

/**
 * The service laws (owner's 2026-09 brief — "enforce such laws of a cafe and
 * restaurant"):
 *
 *   Law 1 — the till opens the day: no new orders while the drawer is closed.
 *   Law 2 — money needs an open till: no settlement, tip or payment record
 *           against a closed drawer.
 *   Law 3 — the floor serves: only manager / head-waiter / cashier may put an
 *           order 'served'; the kitchen hands off with 'fulfilled'.
 *   Law 4 — each station owns its lines: a bar handoff on a mixed ticket must
 *           never move the kitchen's food, and the order's status is derived
 *           from every line afterwards.
 *
 * Everything here runs against a SQL-shaped D1 fake — the same approach the
 * orders tests use — so the exact statements the handlers issue stay pinned.
 */

function makeEnv({ orderRows = [], itemRows = [], tillOpen = true } = {}) {
  const run = vi.fn().mockResolvedValue({ meta: { changes: 1 }, results: [] });
  const boundParams = [];
  const prepare = vi.fn(function (sql) {
    return {
      bind: (...params) => {
        boundParams.push({ sql, params });
        return {
          all: async () => {
            if (/FROM cashdrawers WHERE status = 'open'/.test(sql)) {
              return { results: tillOpen ? [{ id: 'Dtill01' }] : [] };
            }
            if (/SELECT category, name FROM order_items/.test(sql)) {
              return { results: itemRows.filter((r) => String(r.id) === String(params[0])) };
            }
            if (/SELECT id, status, category, name FROM order_items/.test(sql)) {
              return { results: itemRows };
            }
            if (/SELECT status FROM order_items/.test(sql)) {
              return { results: itemRows.map((r) => ({ status: r.status })) };
            }
            if (/FROM orders WHERE id/.test(sql)) return { results: orderRows };
            return { results: [] };
          },
          run,
        };
      },
    };
  });
  return { env: { DB: { prepare, batch: vi.fn() } }, run, boundParams };
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
  id: 'Olaw01',
  items: '[{"name":"Latte","qty":1},{"name":"Firfir","qty":1}]',
  total: 200,
  type: 'dine-in',
  table_id: '4',
  status: 'ready',
  created: '2026-09-24T10:00:00',
};

// A mixed ticket: one drink line the bar owns, one food line the kitchen owns.
const MIXED_LINES = [
  { id: 'LI-drink', order_id: 'Olaw01', line_no: 0, name: 'Latte', category: 'HOT DRINKS', qty: 1, unit_price: 60, status: 'ready' },
  { id: 'LI-food', order_id: 'Olaw01', line_no: 1, name: 'Firfir', category: 'FOOD', qty: 1, unit_price: 140, status: 'preparing' },
];

const CTX = { waitUntil() {} };

afterEach(() => {
  clearChannelCacheForTest();
});

describe('Law 1 — the till opens the day', () => {
  it('refuses a staff order while the drawer is closed', async () => {
    const { env } = makeEnv({ tillOpen: false });
    const { pathname, method, url, request } = makeRequest('/api/orders', 'POST', {
      items: '1xLatte',
      total: 60,
      type: 'takeaway',
    });
    const res = await handleOrders(pathname, method, url, request, env, CTX, { staff_id: 'S1', role: 'head-waiter' });
    expect(res.status).toBe(409);
    const parsed = await res.json();
    expect(parsed.reason).toBe('till-closed');
    expect(parsed.error).toMatch(/till is closed/i);
  });

  it('refuses a guest order with the counter message', async () => {
    const { env } = makeEnv({ tillOpen: false });
    const { pathname, method, url, request } = makeRequest('/api/orders', 'POST', {
      items: '1xLatte',
      total: 60,
      type: 'takeaway',
    });
    const res = await handleOrders(pathname, method, url, request, env, CTX, null);
    expect(res.status).toBe(503);
    const parsed = await res.json();
    expect(parsed.reason).toBe('till-closed');
    expect(parsed.error).toMatch(/order at the counter/i);
  });
});

describe('Law 2 — money needs an open till', () => {
  it('refuses a settlement posted against a closed drawer', async () => {
    const { env } = makeEnv({ orderRows: [ORDER], itemRows: MIXED_LINES, tillOpen: false });
    const { pathname, method, url, request } = makeRequest('/api/orders/Olaw01', 'PUT', {
      status: 'served',
      paymentBreakdown: [{ method: 'cash', amount: 200 }],
    });
    const res = await handleOrders(pathname, method, url, request, env, CTX, { staff_id: 'S1', role: 'cashier' });
    expect(res.status).toBe(409);
    const parsed = await res.json();
    expect(parsed.reason).toBe('till-closed');
  });

  // The settlement gates (role + till) live in the settlement block, which a
  // PUT carrying ONLY money used to never reach — "No fields to update" (400)
  // fired first, silently doing nothing for a client that believes it just
  // took cash. A settlement-only body must ride the same gates.
  it('gates a settlement-only PUT (no status, no fields) on the open till', async () => {
    const { env } = makeEnv({ orderRows: [ORDER], itemRows: MIXED_LINES, tillOpen: false });
    const { pathname, method, url, request } = makeRequest('/api/orders/Olaw01', 'PUT', {
      paymentBreakdown: [{ method: 'cash', amount: 200 }],
    });
    const res = await handleOrders(pathname, method, url, request, env, CTX, { staff_id: 'S1', role: 'cashier' });
    expect(res.status).toBe(409);
    const parsed = await res.json();
    expect(parsed.reason).toBe('till-closed');
  });

  it('lets a settlement-only PUT through when the till is open', async () => {
    const { env } = makeEnv({ orderRows: [ORDER], itemRows: MIXED_LINES, tillOpen: true });
    const { pathname, method, url, request } = makeRequest('/api/orders/Olaw01', 'PUT', {
      paymentBreakdown: [{ method: 'cash', amount: 200 }],
    });
    const res = await handleOrders(pathname, method, url, request, env, CTX, { staff_id: 'S1', role: 'cashier' });
    expect(res.status).not.toBe(400);
    const parsed = await res.json();
    expect(parsed.ok).toBe(true);
  });
});

describe('Law 3 — the floor serves', () => {
  it('refuses the kitchen the word served', async () => {
    const { env } = makeEnv({ orderRows: [ORDER], itemRows: MIXED_LINES });
    for (const role of ['head-chef', 'assistant-chef', 'barista']) {
      const { pathname, method, url, request } = makeRequest('/api/orders/Olaw01', 'PUT', { status: 'served' });
      const res = await handleOrders(pathname, method, url, request, env, CTX, { staff_id: 'S1', role });
      expect(res.status).toBe(403);
      const parsed = await res.json();
      expect(parsed.error).toMatch(/floor can mark/i);
    }
  });

  it('lets the floor mark served', async () => {
    const { env } = makeEnv({ orderRows: [ORDER], itemRows: MIXED_LINES });
    const { pathname, method, url, request } = makeRequest('/api/orders/Olaw01', 'PUT', { status: 'served' });
    const res = await handleOrders(pathname, method, url, request, env, CTX, { staff_id: 'S1', role: 'head-waiter' });
    expect(res.status).toBe(200);
  });
});

describe('Law 4 — each station owns its lines', () => {
  it('a barista handoff moves drink lines only and derives the order status', async () => {
    const { env, boundParams } = makeEnv({ orderRows: [ORDER], itemRows: MIXED_LINES });
    const { pathname, method, url, request } = makeRequest('/api/orders/Olaw01', 'PUT', { status: 'fulfilled' });
    const res = await handleOrders(pathname, method, url, request, env, CTX, { staff_id: 'S1', role: 'barista' });
    expect(res.status).toBe(200);
    const parsed = await res.json();
    expect(parsed.ok).toBe(true);

    // Only the drink line moves, to 'served' (fulfilled's line word).
    const lineUpdates = boundParams.filter((b) => /UPDATE order_items SET/.test(b.sql));
    expect(lineUpdates.length).toBeGreaterThan(0);
    for (const u of lineUpdates) {
      expect(u.params).toContain('served');
      expect(u.params).toContain('LI-drink');
      expect(u.params).not.toContain('LI-food');
    }

    // The order itself is re-derived from ALL lines: food is still
    // 'preparing', so the ticket reads 'preparing' — not 'fulfilled'.
    const orderUpdate = boundParams.find((b) => /UPDATE orders SET status/.test(b.sql));
    expect(orderUpdate).toBeTruthy();
    expect(orderUpdate.params[0]).toBe('preparing');
  });

  it('a chef write is forced into the kitchen scope', async () => {
    const { env, boundParams } = makeEnv({ orderRows: [ORDER], itemRows: MIXED_LINES });
    // The chef asks for the WHOLE ticket; the server still scopes to food.
    const { pathname, method, url, request } = makeRequest('/api/orders/Olaw01', 'PUT', { status: 'preparing', station: 'bar' });
    const res = await handleOrders(pathname, method, url, request, env, CTX, { staff_id: 'S1', role: 'head-chef' });
    expect(res.status).toBe(200);
    const lineUpdates = boundParams.filter((b) => /UPDATE order_items SET/.test(b.sql));
    for (const u of lineUpdates) {
      expect(u.params).not.toContain('LI-drink');
    }
  });

  it('a barista cannot advance a food line one at a time', async () => {
    const { env } = makeEnv({ orderRows: [ORDER], itemRows: MIXED_LINES });
    const { pathname, method, url, request } = makeRequest('/api/orders/Olaw01/items/LI-food', 'PUT', { status: 'ready' });
    const res = await handleOrders(pathname, method, url, request, env, CTX, { staff_id: 'S1', role: 'barista' });
    expect(res.status).toBe(403);
    const parsed = await res.json();
    expect(parsed.error).toMatch(/food/i);
  });

  it('an explicit bar scope from the floor moves drink lines only', async () => {
    const { env, boundParams } = makeEnv({ orderRows: [ORDER], itemRows: MIXED_LINES });
    const { pathname, method, url, request } = makeRequest('/api/orders/Olaw01', 'PUT', { status: 'fulfilled', station: 'bar' });
    const res = await handleOrders(pathname, method, url, request, env, CTX, { staff_id: 'S1', role: 'manager' });
    expect(res.status).toBe(200);
    const lineUpdates = boundParams.filter((b) => /UPDATE order_items SET/.test(b.sql));
    for (const u of lineUpdates) {
      expect(u.params).not.toContain('LI-food');
    }
  });
});

describe('the kitchen channel earns its event name', () => {
  it('announces new_order only when the board gains a ticket', async () => {
    const env = {
      DB: {
        prepare: vi.fn((sql) => ({
          bind: () => ({
            all: async () => {
              if (/MAX\(updated_at\)/.test(sql)) return { results: [{ u: '2026-09-24T10:00:00' }] };
              if (/FROM orders WHERE/.test(sql)) {
                return { results: [{ id: 'Oa1', status: 'new', created: '2026-09-24T09:00:00', updated_at: '2026-09-24T10:00:00' }] };
              }
              return { results: [] };
            },
            run: vi.fn(),
          }),
        })),
      },
    };
    const client = { auth: null, allowedRules: [], managerSeesAll: false, lastSig: null, lastMode: null };

    // First tick — baseline: no announcement.
    const first = await tickChannel('kitchen', env, client, { nowMs: 1000 });
    expect(first.keepaliveOnly).toBe(false);
    expect(kitchenEventName(first.view)).toBe('order_update');

    // Same board — still no announcement.
    const second = await tickChannel('kitchen', env, client, { nowMs: 900000 });
    expect(kitchenEventName(second.view)).toBe('order_update');

    // A genuinely new ticket lands — new_order, with its id.
    env.DB.prepare = vi.fn((sql) => ({
      bind: () => ({
        all: async () => {
          if (/MAX\(updated_at\)/.test(sql)) return { results: [{ u: '2026-09-24T10:05:00' }] };
          if (/FROM orders WHERE/.test(sql)) {
            return {
              results: [
                { id: 'Oa1', status: 'new', created: '2026-09-24T09:00:00', updated_at: '2026-09-24T10:00:00' },
                { id: 'Ob2', status: 'new', created: '2026-09-24T10:05:00', updated_at: '2026-09-24T10:05:00' },
              ],
            };
          }
          return { results: [] };
        },
        run: vi.fn(),
      }),
    }));
    clearChannelCacheForTest();
    // Baseline again on the fresh cache (isolate semantics), then the gain.
    await tickChannel('kitchen', env, client, { nowMs: 1800000 });
    env.DB.prepare = vi.fn((sql) => ({
      bind: () => ({
        all: async () => {
          if (/MAX\(updated_at\)/.test(sql)) return { results: [{ u: '2026-09-24T10:06:00' }] };
          if (/FROM orders WHERE/.test(sql)) {
            return {
              results: [
                { id: 'Oa1', status: 'new', created: '2026-09-24T09:00:00', updated_at: '2026-09-24T10:00:00' },
                { id: 'Ob2', status: 'new', created: '2026-09-24T10:05:00', updated_at: '2026-09-24T10:05:00' },
                { id: 'Oc3', status: 'new', created: '2026-09-24T10:06:00', updated_at: '2026-09-24T10:06:00' },
              ],
            };
          }
          return { results: [] };
        },
        run: vi.fn(),
      }),
    }));
    const gain = await tickChannel('kitchen', env, client, { nowMs: 2700000 });
    expect(kitchenEventName(gain.view)).toBe('new_order');
    expect(gain.view.newIds).toContain('Oc3');
    expect(gain.view.newIds).not.toContain('Oa1');
  });
});
