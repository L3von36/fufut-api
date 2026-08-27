/**
 * What a guest's order may cost — the server side.
 *
 * POST /api/orders is public on purpose (the website and the QR table codes),
 * which makes it the one write a stranger can reach. Until 2026-08-27 every
 * figure on the receipt came off the wire: three probe orders landed live at
 * attacker-chosen prices (Ocff9d5a: a 150-birr espresso for 1; O16e8cab: two
 * of them, "completed" and "paid" by the same POST; O6d9a999: an invented
 * dish at 0). These tests replay those attacks against the fixed handler and
 * pin the honest paths too, so the route can stay open without staying
 * trusting.
 *
 * Run through the real Worker against real SQLite — the claim is about what
 * gets written to the orders, order_items, payments and tips tables, and a
 * mocked database would only prove the checks call the mock.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import worker from '../src/index.js';
import { createLocalEnv } from '../local/env.js';
import { hashPassword } from '../src/lib/crypto.js';

let dir;
let env;
let db;
let managerCookie = '';

// The live menu, in miniature: the real Espresso id is MIe6d19d99 and the
// real probe used it, but only the price matters here.
const ESPRESSO = { id: 'MIe6d19d99', name: 'Espresso', price: 150 };
const TEA = { id: 'MIb54a9f4d', name: 'TEA', price: 70 };

function call(method, url, { body, cookie } = {}) {
  const request = new Request('http://localhost:8787' + url, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return worker
    .fetch(request, env, { waitUntil() {}, passThroughOnException() {} })
    .then(async (r) => ({ status: r.status, body: await r.clone().json().catch(() => null) }));
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fufut-pricing-'));
  ({ env, db } = createLocalEnv({ dir, quiet: true }));

  const ins = db.prepare(
    "INSERT INTO menu_items (id, category_id, name, price, available) VALUES (?, 'C1', ?, ?, 1)"
  );
  ins.run(ESPRESSO.id, ESPRESSO.name, ESPRESSO.price);
  ins.run(TEA.id, TEA.name, TEA.price);

  db.prepare(
    `INSERT INTO staff (id, firstName, lastName, email, role, status, password_hash, must_change_password, created)
     VALUES ('M1','A','B','mgr@local.test','manager','active',?,0,?)`
  ).run(await hashPassword('managerpass1'), new Date().toISOString());

  await call('POST', '/api/auth/login', { body: { email: 'mgr@local.test', password: 'managerpass1' } });
  managerCookie = `session=${db.prepare('SELECT token FROM sessions LIMIT 1').get().token}`;
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const orderRow = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
const linesFor = (id) => db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY line_no').all(id);
const paymentsFor = (id) => db.prepare('SELECT * FROM payments WHERE order_id = ?').all(id);
const tipsFor = (id) => db.prepare('SELECT * FROM tips WHERE order_id = ?').all(id);

// ── The three live attacks, replayed ─────────────────────────────────────────

describe('attack A: a named dish at an invented price', () => {
  it('is accepted at the menu price, not the posted one', async () => {
    const res = await call('POST', '/api/orders', {
      body: {
        items: [{ id: ESPRESSO.id, name: 'Espresso', qty: 1, price: 1 }],
        total: 1,
        name: 'ATTACKER',
        order_type: 'takeaway',
        status: 'new',
      },
    });

    expect(res.status).toBeLessThan(300);
    expect(res.body.repriced).toBe(true);

    const row = orderRow(res.body.id);
    expect(row.total).toBe(150);
    expect(row.subtotal).toBe(150);
    expect(linesFor(res.body.id)[0].unit_price).toBe(150);
  });
});

describe('attack B: marking an order completed and paid in the same POST', () => {
  it('lands as a new, unpaid order at menu prices', async () => {
    const res = await call('POST', '/api/orders', {
      body: {
        items: [{ id: ESPRESSO.id, name: 'Espresso', qty: 2, price: 0.5 }],
        total: 1,
        name: 'ATTACKER-PAID',
        order_type: 'takeaway',
        status: 'completed',
        payment: 'cash',
        paymentBreakdown: [{ method: 'cash', amount: 1, tendered: 1, change: 0 }],
      },
    });

    expect(res.status).toBeLessThan(300);

    const row = orderRow(res.body.id);
    expect(row.total).toBe(300);
    expect(row.status).toBe('new');
    expect(row.payment_status).toBe('unpaid');
    expect(row.payment).toBeNull();

    // The self-verified cash leg is gone with the rest of the claim.
    expect(paymentsFor(res.body.id)).toEqual([]);
    expect(res.body.payments).toBe(0);
  });

  it('writes no anonymous tip row either', async () => {
    const res = await call('POST', '/api/orders', {
      body: {
        items: [{ id: TEA.id, name: 'TEA', qty: 1, price: 70 }],
        total: 70,
        tip: 30,
        name: 'ATTACKER-TIP',
        order_type: 'takeaway',
        status: 'new',
      },
    });

    expect(res.status).toBeLessThan(300);
    // The tip stays on the bill the guest pays (order row), but no tips row
    // is created — there is no staff member to owe it to.
    const row = orderRow(res.body.id);
    expect(row.total).toBe(100);
    expect(row.tip).toBe(30);
    expect(tipsFor(res.body.id)).toEqual([]);
  });
});

describe('attack C: a dish that does not exist', () => {
  it('is refused outright', async () => {
    const res = await call('POST', '/api/orders', {
      body: {
        items: [{ name: 'Gold-Plated Coffee', qty: 1, price: 0 }],
        total: 0,
        name: 'ATTACKER-FREE',
        order_type: 'takeaway',
        status: 'new',
      },
    });

    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('unknown-item');
    expect(db.prepare('SELECT count(*) AS n FROM orders').get().n).toBe(0);
  });
});

// ── The refusals that keep the books honest ──────────────────────────────────

describe('refusals', () => {
  it('refuses an empty order', async () => {
    const res = await call('POST', '/api/orders', {
      body: { items: [], total: 0, name: 'Empty', order_type: 'takeaway' },
    });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('no-items');
  });

  it('refuses a dish the kitchen has taken off', async () => {
    db.prepare('UPDATE menu_items SET available = 0 WHERE id = ?').run(TEA.id);
    const res = await call('POST', '/api/orders', {
      body: { items: [{ id: TEA.id, name: 'TEA', qty: 1, price: 70 }], total: 70, order_type: 'takeaway' },
    });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('unavailable-item');
  });

  it('refuses the whole order when the menu cannot be read', async () => {
    db.exec('DROP TABLE menu_items');
    const res = await call('POST', '/api/orders', {
      body: { items: [{ id: TEA.id, name: 'TEA', qty: 1, price: 70 }], total: 70, order_type: 'takeaway' },
    });
    expect(res.status).toBe(503);
    expect(res.body.reason).toBe('menu-unavailable');
    expect(db.prepare('SELECT count(*) AS n FROM orders').get().n).toBe(0);
  });

  it('refuses the whole order when the menu is empty', async () => {
    db.exec('DELETE FROM menu_items');
    const res = await call('POST', '/api/orders', {
      body: { items: [{ id: TEA.id, name: 'TEA', qty: 1, price: 70 }], total: 70, order_type: 'takeaway' },
    });
    expect(res.status).toBe(503);
    expect(res.body.reason).toBe('menu-unavailable');
  });
});

// ── The arithmetic ───────────────────────────────────────────────────────────

describe('guest arithmetic', () => {
  it('drops a self-authorised discount', async () => {
    const res = await call('POST', '/api/orders', {
      body: {
        items: [{ id: ESPRESSO.id, name: 'Espresso', qty: 1, price: 150 }],
        total: 50,
        subtotal: 150,
        discount: 100,
        discountType: 'amount',
        discountReason: 'because I said so',
        order_type: 'takeaway',
      },
    });

    expect(res.status).toBeLessThan(300);
    const row = orderRow(res.body.id);
    expect(row.total).toBe(150);
    expect(row.discount).toBe(0);
    expect(row.discount_reason).toBeNull();
  });

  it('clamps a negative tip and keeps an honest one on the bill', async () => {
    const down = await call('POST', '/api/orders', {
      body: { items: [{ id: TEA.id, name: 'TEA', qty: 1, price: 70 }], total: 20, tip: -50, order_type: 'takeaway' },
    });
    expect(orderRow(down.body.id).total).toBe(70);

    const up = await call('POST', '/api/orders', {
      body: { items: [{ id: TEA.id, name: 'TEA', qty: 1, price: 70 }], total: 90, tip: 20, order_type: 'takeaway' },
    });
    const row = orderRow(up.body.id);
    expect(row.tip).toBe(20);
    expect(row.total).toBe(90);
  });

  it('recognises a dish by name when no id is sent', async () => {
    const res = await call('POST', '/api/orders', {
      body: { items: [{ name: 'espresso', qty: 1, price: 1 }], total: 1, order_type: 'takeaway' },
    });
    expect(res.status).toBeLessThan(300);
    expect(orderRow(res.body.id).total).toBe(150);
  });

  it('uses the menu spelling of a dish whose id is right but whose name is a lie', async () => {
    const res = await call('POST', '/api/orders', {
      body: { items: [{ id: ESPRESSO.id, name: 'Free Water', qty: 1, price: 0 }], total: 0, order_type: 'takeaway' },
    });
    expect(res.status).toBeLessThan(300);
    const line = linesFor(res.body.id)[0];
    expect(line.name).toBe('Espresso');
    expect(line.unit_price).toBe(150);
    expect(orderRow(res.body.id).total).toBe(150);
  });

  it('ignores an id a guest chose for their own order', async () => {
    const res = await call('POST', '/api/orders', {
      body: {
        id: 'Osquatting',
        items: [{ id: TEA.id, name: 'TEA', qty: 1, price: 70 }],
        total: 70,
        order_type: 'takeaway',
      },
    });
    expect(res.status).toBeLessThan(300);
    expect(res.body.id).not.toBe('Osquatting');
    expect(orderRow('Osquatting')).toBeUndefined();
  });

  it('flags a repriced order in the audit trail', async () => {
    await call('POST', '/api/orders', {
      body: { items: [{ id: ESPRESSO.id, name: 'Espresso', qty: 1, price: 1 }], total: 1, order_type: 'takeaway' },
    });
    const audit = JSON.parse(
      db.prepare("SELECT after FROM audit_log WHERE entity = 'orders' ORDER BY at DESC LIMIT 1").get().after
    );
    expect(audit.guest_repriced).toBe(true);
    expect(audit.total).toBe(150);
  });
});

// ── Nothing that was honest breaks ───────────────────────────────────────────

describe('honest traffic', () => {
  it('takes the website order exactly as the website sends it', async () => {
    // The exact payload shape of website/js/order.js and index.html.
    const res = await call('POST', '/api/orders', {
      body: {
        items: [
          { id: ESPRESSO.id, name: 'Espresso', qty: 2, price: 150 },
          { id: TEA.id, name: 'TEA', qty: 1, price: 70 },
        ],
        total: 370,
        name: 'A Real Guest',
        phone: '+251911000000',
        email: '',
        order_type: 'dine-in',
        table_number: '3',
        table_key: undefined,
        notes: 'less sugar',
        status: 'new',
      },
    });

    expect(res.status).toBeLessThan(300);
    expect(res.body.ok).toBe(true);
    // No correction was needed, so no correction is reported.
    expect(res.body.repriced).toBeUndefined();

    const row = orderRow(res.body.id);
    expect(row.total).toBe(370);
    expect(row.subtotal).toBe(370);
    expect(row.customer).toBe('A Real Guest');

    const lines = linesFor(res.body.id);
    expect(lines.map((l) => l.name)).toEqual(['Espresso', 'TEA']);
    expect(lines[0].unit_price).toBe(150);
    expect(lines[0].qty).toBe(2);
  });

  it('still seats a QR table order, priced from the menu', async () => {
    db.prepare("INSERT INTO tables (id, number, name, status, qr_key) VALUES ('T4', 4, 'Table 4', 'available', 'k1')").run();

    const res = await call('POST', '/api/orders', {
      body: {
        items: [{ id: TEA.id, name: 'TEA', qty: 2, price: 0.01 }],
        total: 0.02,
        table_number: '4',
        table_key: 'k1',
        status: 'new',
      },
    });

    expect(res.status).toBeLessThan(300);
    const row = orderRow(res.body.id);
    expect(row.source).toBe('qr');
    expect(row.total).toBe(140);
    expect(db.prepare("SELECT status FROM tables WHERE id = 'T4'").get().status).toBe('occupied');
  });

  it('leaves a signed-in order untouched — prices, discount and all', async () => {
    // The till computes its own totals, including manager-approved
    // discounts, and the write is attributed: none of that is the guest
    // gate's business.
    const res = await call('POST', '/api/orders', {
      cookie: managerCookie,
      body: {
        items: [{ name: 'House Special', qty: 1, price: 120 }],
        total: 60,
        subtotal: 120,
        discount: 60,
        discountReason: 'regular',
        order_type: 'takeaway',
        status: 'new',
      },
    });

    expect(res.status).toBeLessThan(300);
    expect(res.body.repriced).toBeUndefined();
    const row = orderRow(res.body.id);
    expect(row.total).toBe(60);
    expect(row.discount).toBe(60);
    expect(row.created_by).toBe('M1');
  });
});
