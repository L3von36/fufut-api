/**
 * Ordering from the code on the table — the server side.
 *
 * Run through the real Worker against real SQLite, because the thing being
 * claimed is that a stranger cannot attach an order to a table they are not
 * sitting at. A mocked database would only prove the checks call the mock.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import worker from '../src/index.js';
import { createLocalEnv } from '../local/env.js';
import { hashPassword } from '../src/lib/crypto.js';
import { generateTableKey, keysMatch } from '../src/lib/tablekey.js';

let dir;
let env;
let db;
let managerCookie = '';

const KEY = 'abc23xyz78';
const ORDER = { items: [{ name: 'Buna', qty: 2, price: 60 }], total: 120 };

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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fufut-qr-'));
  ({ env, db } = createLocalEnv({ dir, quiet: true }));

  // qr_key and source come from the bundled schema (migration 015).

  db.prepare("INSERT INTO tables (id, number, name, status, qr_key) VALUES ('T4', 4, 'Table 4', 'available', ?)").run(KEY);
  db.prepare("INSERT INTO tables (id, number, name, status) VALUES ('T5', 5, 'Table 5', 'available')").run();

  db.prepare(
    `INSERT INTO staff (id, firstName, lastName, email, role, status, password_hash, must_change_password, created)
     VALUES ('M1','A','B','mgr@local.test','manager','active',?,0,?)`
  ).run(await hashPassword('managerpass1'), new Date().toISOString());

  const login = await call('POST', '/api/auth/login', { body: { email: 'mgr@local.test', password: 'managerpass1' } });
  managerCookie = `session=${db.prepare('SELECT token FROM sessions LIMIT 1').get().token}`;
  expect(login.status).toBe(200);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const orderRow = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
const table = (id) => db.prepare('SELECT * FROM tables WHERE id = ?').get(id);

describe('the key is what identifies the table', () => {
  it('accepts an order carrying the right code', async () => {
    const res = await call('POST', '/api/orders', { body: { ...ORDER, table_number: '4', table_key: KEY } });

    expect(res.status).toBeLessThan(300);
    const row = orderRow(res.body.id);
    // Filed under the normalised reference, not the raw `tables.id`. The id
    // is free text — "T4" here, "Table 4" in production — and filing a QR
    // order under it put the guest's order where no screen looked for it.
    expect(row.table_id).toBe('4');
    expect(row.source).toBe('qr');
  });

  it('refuses a guessed code', async () => {
    // The whole point: `?t=4` alone must not be enough.
    const res = await call('POST', '/api/orders', { body: { ...ORDER, table_number: '4', table_key: 'wrongwrong' } });

    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('bad-table-code');
    expect(db.prepare('SELECT count(*) AS n FROM orders').get().n).toBe(0);
  });

  it('refuses a table that has no code yet', async () => {
    const res = await call('POST', '/api/orders', { body: { ...ORDER, table_number: '5', table_key: KEY } });
    expect(res.status).toBe(403);
  });

  it('will not let one table\'s code order at another table', async () => {
    // Table 5 has no key of its own; table 4's must not work there either.
    const res = await call('POST', '/api/orders', { body: { ...ORDER, table_number: '5', table_key: KEY } });
    expect(res.status).toBe(403);
  });

  it('files the order under the table the code proves, not the one claimed', async () => {
    // A tampered payload naming a different table must not be filed there.
    const res = await call('POST', '/api/orders', {
      body: { ...ORDER, table_number: '4', table_key: KEY, table_id: 'T9', type: 'delivery' },
    });

    const row = orderRow(res.body.id);
    // Table 4, whatever that table's id happens to be spelled like — and
    // emphatically not the table 9 the payload asked for.
    expect(row.table_id).toBe('4');
    expect(row.table_id).not.toBe('9');
    expect(row.table_id).not.toBe('T9');
    // A code on table 4 is not a delivery.
    expect(row.type).toBe('dine-in');
  });
});

describe('nothing that exists today changes', () => {
  it('still takes an ordinary order with no code at all', async () => {
    const res = await call('POST', '/api/orders', { body: { ...ORDER, type: 'delivery', name: 'Selam' } });

    expect(res.status).toBeLessThan(300);
    const row = orderRow(res.body.id);
    expect(row.type).toBe('delivery');
    expect(row.source).toBeNull();
  });
});

describe('the first scan seats the table', () => {
  it('marks an empty table occupied', async () => {
    expect(table('T4').status).toBe('available');

    await call('POST', '/api/orders', { body: { ...ORDER, table_number: '4', table_key: KEY } });

    expect(table('T4').status).toBe('occupied');
    expect(table('T4').seated_at).toBeTruthy();
  });

  it('leaves an occupied table alone on a second round', async () => {
    await call('POST', '/api/orders', { body: { ...ORDER, table_number: '4', table_key: KEY } });
    const firstSeating = table('T4').seated_at;

    await call('POST', '/api/orders', { body: { ...ORDER, table_number: '4', table_key: KEY } });

    // A second round must not reset who is sitting there, or how long for.
    expect(table('T4').seated_at).toBe(firstSeating);
    expect(db.prepare('SELECT count(*) AS n FROM orders').get().n).toBe(2);
  });
});

describe('minting the codes', () => {
  it('gives a manager a card to print', async () => {
    const res = await call('POST', '/api/tables/T5/qr', { cookie: managerCookie });

    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/\/order\?t=T5&k=/);
    expect(res.body.replaced).toBe(false);
    expect(table('T5').qr_key).toBeTruthy();
  });

  it('replacing a code invalidates the printed card', async () => {
    // The reason the key is per-table: a card that walks off costs one reprint.
    const before = table('T4').qr_key;
    const res = await call('POST', '/api/tables/T4/qr', { cookie: managerCookie });

    expect(res.body.replaced).toBe(true);
    expect(table('T4').qr_key).not.toBe(before);

    const refused = await call('POST', '/api/orders', { body: { ...ORDER, table_number: '4', table_key: before } });
    expect(refused.status).toBe(403);
  });

  it('lists which tables still need a card', async () => {
    const res = await call('GET', '/api/tables/qr', { cookie: managerCookie });

    const four = res.body.tables.find((t) => t.id === 'T4');
    const five = res.body.tables.find((t) => t.id === 'T5');
    expect(four.hasKey).toBe(true);
    expect(five.hasKey).toBe(false);
    expect(five.url).toBeNull();
  });

  it('is not something a waiter can do', async () => {
    // The list is every table's secret; minting invalidates printed cards.
    const anonymous = await call('POST', '/api/tables/T5/qr');
    expect(anonymous.status).toBe(401);

    const listed = await call('GET', '/api/tables/qr');
    expect(listed.status).toBe(401);
  });
});

describe('the key itself', () => {
  it('is not derivable from the table number', () => {
    const keys = new Set(Array.from({ length: 50 }, () => generateTableKey()));
    expect(keys.size).toBe(50);
    expect([...keys][0]).toHaveLength(10);
  });

  it('avoids characters nobody can read back over the phone', () => {
    const joined = Array.from({ length: 40 }, () => generateTableKey()).join('');
    expect(joined).not.toMatch(/[ilo01]/);
  });

  it('compares without caring how nearly right a guess was', () => {
    expect(keysMatch('abc23xyz78', 'abc23xyz78')).toBe(true);
    expect(keysMatch('abc23xyz79', 'abc23xyz78')).toBe(false);
    expect(keysMatch('', 'abc23xyz78')).toBe(false);
    expect(keysMatch('abc23xyz78', '')).toBe(false);
  });
});

describe("a guest's order waits for a waiter", () => {
  async function guestOrder() {
    const res = await call('POST', '/api/orders', { body: { ...ORDER, table_number: '4', table_key: KEY } });
    return res.body.id;
  }

  const onKitchenBoard = async (cookie) =>
    (await call('GET', '/api/orders/items/active', { cookie })).body || [];

  it('does not reach the kitchen board before it is accepted', async () => {
    // The whole reason the accept step exists: a photographed code must not
    // put food on the pass by itself.
    const id = await guestOrder();

    const board = await onKitchenBoard(managerCookie);
    expect(board.some((i) => i.order_id === id)).toBe(false);
  });

  it('reaches the board once a waiter accepts it', async () => {
    const id = await guestOrder();

    const accepted = await call('POST', `/api/orders/${id}/accept`, { cookie: managerCookie });
    expect(accepted.status).toBe(200);
    expect(accepted.body.status).toBe('confirmed');

    const board = await onKitchenBoard(managerCookie);
    expect(board.some((i) => i.order_id === id)).toBe(true);
  });

  it('lists what is waiting, and stops listing it once accepted', async () => {
    const id = await guestOrder();

    let pending = (await call('GET', '/api/orders/pending', { cookie: managerCookie })).body;
    expect(pending.map((o) => o.id)).toContain(id);

    await call('POST', `/api/orders/${id}/accept`, { cookie: managerCookie });

    pending = (await call('GET', '/api/orders/pending', { cookie: managerCookie })).body;
    expect(pending.map((o) => o.id)).not.toContain(id);
  });

  it('cannot be accepted by somebody with no session', async () => {
    const id = await guestOrder();
    const res = await call('POST', `/api/orders/${id}/accept`);
    expect(res.status).toBe(401);
  });

  it('is harmless to accept twice', async () => {
    // Two waiters can tap at once; the second must not be an error thrown at
    // somebody who did nothing wrong.
    const id = await guestOrder();
    await call('POST', `/api/orders/${id}/accept`, { cookie: managerCookie });
    const again = await call('POST', `/api/orders/${id}/accept`, { cookie: managerCookie });

    expect(again.status).toBe(200);
    expect(again.body.alreadyAccepted).toBe(true);
  });

  it('leaves staff-entered orders going straight through', async () => {
    // Nothing about the floor's own workflow changes.
    const staff = await call('POST', '/api/orders', {
      cookie: managerCookie,
      body: { ...ORDER, type: 'dine-in', tableNum: '5' },
    });

    const board = await onKitchenBoard(managerCookie);
    expect(board.some((i) => i.order_id === staff.body.id)).toBe(true);

    const refused = await call('POST', `/api/orders/${staff.body.id}/accept`, { cookie: managerCookie });
    expect(refused.status).toBe(400);
  });
});
