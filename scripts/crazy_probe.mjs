/**
 * crazy_probe.mjs — the owner's "do crazy test this kind throughout the
 * project" mandate, run LIVE against the real API surface (worker.fetch over
 * the local D1 runtime — the exact code path the box runs, minus the wire).
 *
 * Scenarios:
 *   S1  Mixed-ticket station isolation (barista ready can never move kitchen
 *       food; chef work can never move bar drinks; station handoffs are
 *       scoped and the order status is re-derived from ALL lines).
 *   S2  Same-table multi-order independence (advancing one order's lines
 *       leaves the neighbouring ticket untouched — the tableId/orderId bug).
 *   S3  Line-level station fence (a barista PUT on a food line is refused).
 *   S4  Service laws over HTTP (till gates on orders and money; the floor
 *       serves, the kitchen hands off).
 *   S5  Settlement truth (paid order marked paid; law gates respected).
 *
 * Run:  node scripts/crazy_probe.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import worker from '../src/index.js';
import { createLocalEnv } from '../local/env.js';
import { hashPassword } from '../src/lib/crypto.js';

const results = [];
function assert(cond, label, detail = '') {
  results.push({ ok: !!cond, label, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail && !cond ? ` — ${detail}` : ''}`);
}

let env, db, dir;

async function call(method, pathname, { cookie, body } = {}) {
  const request = new Request('http://localhost:8787' + pathname, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const response = await worker.fetch(request, env, { waitUntil() {}, passThroughOnException() {} });
  let payload = null;
  try { payload = await response.clone().json(); } catch { /* not JSON */ }
  return { status: response.status, body: payload, response };
}

async function login(email, password) {
  const r = await call('POST', '/api/auth/login', { body: { email, password } });
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status}`);
  const setCookie = r.response.headers.get('set-cookie');
  return setCookie ? setCookie.split(';')[0] : '';
}

async function getLines(orderId, cookie) {
  const r = await call('GET', `/api/orders/${orderId}`, { cookie });
  const o = r.body && (r.body.order || r.body);
  const items = await call('GET', '/api/orders', { cookie });
  // order_items ride the single-order payload as `items`/`orderItems` or the
  // lines endpoint; fall back to a direct lines read below if needed.
  return { order: o, raw: r };
}

const PW = 'Probe#2026';

async function main() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fufut-crazy-'));
  ({ env, db } = createLocalEnv({ dir, quiet: true }));

  // ── seed ────────────────────────────────────────────────────────────────
  const nowIso = new Date().toISOString();
  db.prepare(
    "INSERT INTO cashdrawers (id, opened_at, opening_balance, cash_sales, status, created) VALUES ('CD-probe', ?, 0, 0, 'open', ?)"
  ).run(nowIso, nowIso);

  db.prepare("INSERT INTO categories (id, name, sort_order) VALUES ('C-hot', 'HOT DRINKS', 1)").run();
  db.prepare("INSERT INTO categories (id, name, sort_order) VALUES ('C-food', 'MAIN DISHES', 2)").run();
  db.prepare("INSERT INTO menu_items (id, category_id, name, price, available) VALUES ('MI-latte', 'C-hot', 'Latte', 60, 1)").run();
  db.prepare("INSERT INTO menu_items (id, category_id, name, price, available) VALUES ('MI-firfir', 'C-food', 'Firfir', 140, 1)").run();

  db.prepare("INSERT INTO tables (id, number, name, capacity, section, status, guests) VALUES ('5', 5, 'T5', 4, 'main', 'available', 0)").run();
  db.prepare("INSERT INTO tables (id, number, name, capacity, section, status, guests) VALUES ('10', 10, 'T10', 6, 'main', 'available', 0)").run();

  const staff = [
    { id: 'S-ma', email: 'ma@probe.local', role: 'manager', first: 'Probe', last: 'Manager' },
    { id: 'S-hw', email: 'hw@probe.local', role: 'head-waiter', first: 'Wob', last: 'Floor' },
    { id: 'S-ba', email: 'ba@probe.local', role: 'barista', first: 'Bean', last: 'Bar' },
    { id: 'S-hc', email: 'hc@probe.local', role: 'head-chef', first: 'Chef', last: 'Line' },
    { id: 'S-ca', email: 'ca@probe.local', role: 'cashier', first: 'Cash', last: 'Till' },
  ];
  const hash = await hashPassword(PW);
  for (const s of staff) {
    db.prepare(
      `INSERT INTO staff (id, firstName, lastName, email, role, status, password_hash, must_change_password, created)
       VALUES (?, ?, ?, ?, ?, 'active', ?, 0, ?)`
    ).run(s.id, s.first, s.last, s.email, s.role, hash, nowIso);
  }

  const cookies = {};
  for (const s of staff) cookies[s.role] = await login(s.email, PW);
  console.log('— signed in: manager, head-waiter, barista, head-chef, cashier —\n');

  const hw = cookies['head-waiter'];
  const ba = cookies['barista'];
  const hc = cookies['head-chef'];
  const ma = cookies['manager'];
  const ca = cookies['cashier'];

  async function linesOf(orderId, cookie) {
    const r = await call('GET', '/api/orders/' + orderId, { cookie });
    const o = (r.body && (r.body.order || r.body)) || {};
    // GET /api/orders/:id returns { ...mapOrderRow(order), items: lineRows } —
    // the tracked order_items rows override the summary string under `items`.
    const lines = o.orderItems || o.order_items || (Array.isArray(o.items) ? o.items : []) || o.lines || [];
    return {
      status: r.status,
      orderStatus: o.status,
      paymentStatus: o.payment_status ?? o.paymentStatus,
      lines: Array.isArray(lines) ? lines : [],
      raw: o,
    };
  }

  // ── S1: mixed ticket, two stations, one order ───────────────────────────
  console.log('S1 — mixed-ticket station isolation');
  const mixed = await call('POST', '/api/orders', {
    cookie: hw,
    body: {
      type: 'dine-in', tableNum: '5', status: 'new', total: 200,
      items: [{ name: 'Latte', qty: 1, price: 60 }, { name: 'Firfir', qty: 1, price: 140 }],
    },
  });
  assert(mixed.status < 300, 'S1 head-waiter fires a mixed ticket (drinks + food)', `status ${mixed.status} ${JSON.stringify(mixed.body).slice(0, 200)}`);
  const mixedId = mixed.body.id || (mixed.body.order && mixed.body.order.id);
  assert(!!mixedId, 'S1 mixed ticket has an id');

  let s1 = await linesOf(mixedId, hw);
  const latte = s1.lines.find((l) => l.name === 'Latte');
  const firfir = s1.lines.find((l) => l.name === 'Firfir');
  assert(!!latte && !!firfir, 'S1 both lines tracked as order_items', JSON.stringify(s1.lines).slice(0, 300));
  assert(latte && firfir && String(latte.status) === 'new' && String(firfir.status) === 'new', 'S1 both lines start at new');

  // Barista readies the drink.
  let r = await call('PUT', `/api/orders/${mixedId}/items/${latte.id}`, { cookie: ba, body: { status: 'preparing' } });
  assert(r.status < 300, 'S1 barista starts the drink line', `status ${r.status}`);
  r = await call('PUT', `/api/orders/${mixedId}/items/${latte.id}`, { cookie: ba, body: { status: 'ready' } });
  assert(r.status < 300, 'S1 barista readies the drink line', `status ${r.status}`);
  s1 = await linesOf(mixedId, hw);
  const firAfterBar = s1.lines.find((l) => l.name === 'Firfir');
  assert(firAfterBar && String(firAfterBar.status) === 'new', 'S1 CROSS-POLLUTION: kitchen food still new after drink went ready', `food=${firAfterBar && firAfterBar.status} order=${s1.orderStatus}`);
  assert(s1.orderStatus !== 'ready', 'S1 order NOT ready while food still cooking', `order=${s1.orderStatus}`);

  // Chef cooks the food.
  r = await call('PUT', `/api/orders/${mixedId}/items/${firfir.id}`, { cookie: hc, body: { status: 'preparing' } });
  assert(r.status < 300, 'S1 chef starts the food line', `status ${r.status}`);
  r = await call('PUT', `/api/orders/${mixedId}/items/${firfir.id}`, { cookie: hc, body: { status: 'ready' } });
  assert(r.status < 300, 'S1 chef readies the food line', `status ${r.status}`);
  s1 = await linesOf(mixedId, hw);
  const latAfterChef = s1.lines.find((l) => l.name === 'Latte');
  assert(latAfterChef && String(latAfterChef.status) === 'ready', 'S1 REVERSE-POLLUTION: drink stayed ready while chef cooked', `drink=${latAfterChef && latAfterChef.status}`);
  assert(s1.orderStatus === 'ready', 'S1 order derived ready once BOTH stations finished', `order=${s1.orderStatus}`);

  // Station-scoped handoffs: bar first, then kitchen.
  r = await call('PUT', `/api/orders/${mixedId}`, { cookie: ba, body: { status: 'fulfilled', station: 'bar' } });
  assert(r.status < 300, 'S1 barista hands the DRINKS over (station:bar)', `status ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  s1 = await linesOf(mixedId, hw);
  const firAfterBarHandoff = s1.lines.find((l) => l.name === 'Firfir');
  const latAfterBarHandoff = s1.lines.find((l) => l.name === 'Latte');
  assert(String(latAfterBarHandoff.status).match(/fulfilled|served/), 'S1 drink line moved at the bar handoff', `drink=${latAfterBarHandoff.status}`);
  assert(String(firAfterBarHandoff.status) === 'ready', 'S1 HANDOFF-POLLUTION: food line untouched by the bar handoff', `food=${firAfterBarHandoff.status}`);
  assert(s1.orderStatus !== 'fulfilled', 'S1 order not fulfilled while food waits on the pass', `order=${s1.orderStatus}`);

  r = await call('PUT', `/api/orders/${mixedId}`, { cookie: hc, body: { status: 'fulfilled', station: 'kitchen' } });
  assert(r.status < 300, 'S1 chef hands the FOOD over (station:kitchen)', `status ${r.status}`);
  s1 = await linesOf(mixedId, hw);
  // The line's terminal word is 'served' ('fulfilled' is the ORDER word for
  // picked up), so once every line has landed the derived order reads
  // 'served' — the settle gate opens, which is the point of the flow.
  assert(['served', 'fulfilled'].includes(s1.orderStatus), 'S1 order fully landed after BOTH stations handed off', `order=${s1.orderStatus} raw=${JSON.stringify(s1.raw).slice(0, 200)}`);

  // ── S2: two orders, one table, zero coupling ────────────────────────────
  console.log('\nS2 — same-table multi-order independence');
  const orderA = await call('POST', '/api/orders', {
    cookie: hw,
    body: { type: 'dine-in', tableNum: '10', status: 'new', total: 140, items: [{ name: 'Firfir', qty: 1, price: 140 }] },
  });
  const orderB = await call('POST', '/api/orders', {
    cookie: hw,
    body: { type: 'dine-in', tableNum: '10', status: 'new', total: 60, items: [{ name: 'Latte', qty: 1, price: 60 }] },
  });
  const idA = orderA.body.id || (orderA.body.order && orderA.body.order.id);
  const idB = orderB.body.id || (orderB.body.order && orderB.body.order.id);
  assert(orderA.status < 300 && orderB.status < 300 && idA && idB && idA !== idB, 'S2 two distinct orders seated at table 10', `A=${idA} B=${idB}`);

  const lineA = (await linesOf(idA, hw)).lines.find((l) => l.name === 'Firfir');
  const lineB = (await linesOf(idB, hw)).lines.find((l) => l.name === 'Latte');

  // Chef advances order A ONLY.
  r = await call('PUT', `/api/orders/${idA}/items/${lineA.id}`, { cookie: hc, body: { status: 'preparing' } });
  assert(r.status < 300, 'S2 chef starts order A (food)');
  let a = await linesOf(idA, hw);
  let b = await linesOf(idB, hw);
  assert(String(a.lines[0].status) === 'preparing', 'S2 order A moved');
  assert(b.orderStatus === 'new' && String(b.lines[0].status) === 'new', 'S2 NEIGHBOUR-POLLUTION: order B untouched by A preparing', `B=${b.orderStatus}/${b.lines[0] && b.lines[0].status}`);

  // Barista advances order B ONLY.
  r = await call('PUT', `/api/orders/${idB}/items/${lineB.id}`, { cookie: ba, body: { status: 'ready' } });
  assert(r.status < 300, 'S2 barista readies order B (drink)');
  a = await linesOf(idA, hw);
  b = await linesOf(idB, hw);
  assert(String(a.lines[0].status) === 'preparing' && a.orderStatus === 'preparing', 'S2 order A still preparing while B went ready', `A=${a.orderStatus}/${a.lines[0].status}`);
  assert(b.orderStatus === 'ready' && String(b.lines[0].status) === 'ready', 'S2 order B ready on its own', `B=${b.orderStatus}`);

  // ── S3: the line-level station fence ────────────────────────────────────
  console.log('\nS3 — line-level station fence');
  r = await call('PUT', `/api/orders/${idA}/items/${lineA.id}`, { cookie: ba, body: { status: 'ready' } });
  assert(r.status === 403 || r.status === 409, 'S3 barista refused on a FOOD line', `status ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  r = await call('PUT', `/api/orders/${idB}/items/${lineB.id}`, { cookie: hc, body: { status: 'preparing' } });
  assert(r.status === 403 || r.status === 409, 'S3 chef refused on a DRINK line', `status ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);

  // ── S4: service laws over HTTP ──────────────────────────────────────────
  console.log('\nS4 — service laws');
  // Law 3: the floor serves.
  r = await call('PUT', `/api/orders/${idA}`, { cookie: hc, body: { status: 'served' } });
  assert(r.status === 403, 'S4 Law3: chef cannot write served', `status ${r.status}`);
  r = await call('PUT', `/api/orders/${idB}`, { cookie: ba, body: { status: 'served' } });
  assert(r.status === 403, 'S4 Law3: barista cannot write served', `status ${r.status}`);

  // Hand both tickets over properly, then the floor serves.
  await call('PUT', `/api/orders/${idA}`, { cookie: hc, body: { status: 'fulfilled', station: 'kitchen' } });
  await call('PUT', `/api/orders/${idB}`, { cookie: ba, body: { status: 'fulfilled', station: 'bar' } });
  r = await call('PUT', `/api/orders/${idB}`, { cookie: hw, body: { status: 'served' } });
  assert(r.status < 300, 'S4 Law3: the floor serves a handed-off ticket', `status ${r.status}`);
  b = await linesOf(idB, hw);
  assert(b.orderStatus === 'served', 'S4 order B served', `order=${b.orderStatus}`);

  // Law 1: no new orders while the till is closed.
  r = await call('POST', '/api/cashdrawer/close', { cookie: ma, body: { closingBal: 0 } });
  assert(r.status < 300, 'S4 manager closes the till', `status ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  r = await call('POST', '/api/orders', {
    cookie: hw,
    body: { type: 'dine-in', tableNum: '5', status: 'new', total: 60, items: [{ name: 'Latte', qty: 1, price: 60 }] },
  });
  // Staff get 409 till-closed (503 is the QR guest's variant).
  assert(r.status === 409, 'S4 Law1: new order REFUSED while the till is closed', `status ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);

  // Law 2: money is the till's job — the floor cannot settle, and nobody
  // settles against a closed drawer.
  r = await call('PUT', `/api/orders/${idB}`, { cookie: hw, body: { paymentBreakdown: [{ method: 'cash', amount: 60 }] } });
  assert([400, 403].includes(r.status), 'S4 Law2a: the head-waiter cannot attach money (that is the till)', `status ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  r = await call('PUT', `/api/orders/${idB}`, { cookie: ca, body: { paymentBreakdown: [{ method: 'cash', amount: 60 }] } });
  assert(r.status === 409, 'S4 Law2b: settlement REFUSED while the till is closed', `status ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);

  // Reopen the till — the day continues.
  r = await call('POST', '/api/cashdrawer/open', { cookie: ma, body: { openingFloat: 500 } });
  assert(r.status < 300, 'S4 manager reopens the till', `status ${r.status}`);

  // ── S5: settlement truth ────────────────────────────────────────────────
  console.log('\nS5 — settlement');
  r = await call('PUT', `/api/orders/${idB}`, { cookie: ca, body: { paymentBreakdown: [{ method: 'cash', amount: 60 }] } });
  assert(r.status < 300, 'S5 the till settles order B after serve + open drawer', `status ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  b = await linesOf(idB, hw);
  const paid = (b.paymentStatus || (b.raw && b.raw.payment_status) || '').toString();
  assert(paid === 'paid', 'S5 settled order reads paid', `payment_status=${paid} status=${b.orderStatus}`);

  const list = await call('GET', '/api/orders', { cookie: hw });
  const listed = JSON.stringify(list.body || '');
  assert(listed.includes(idA), 'S5 open order A still listed');
  // A settled ticket must not keep riding the till's open list — the Orders
  // screen reads the same list; a paid order stays only as history.
  const bRow = (list.body && (Array.isArray(list.body) ? list.body : list.body.orders || [])).find?.((o) => o.id === idB);
  if (bRow) {
    const bp = (bRow.payment_status ?? bRow.paymentStatus ?? '').toString();
    assert(bp === 'paid', 'S5 settled order in the list is explicitly paid (not open)', `payment=${bp}`);
  } else {
    assert(true, 'S5 settled order left the orders list entirely');
  }

  // ── verdict ─────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  console.log(`\n═══ crazy probe: ${results.length - failed.length}/${results.length} assertions held ═══`);
  if (failed.length) {
    console.log('FAILED:');
    for (const f of failed) console.log(`  - ${f.label}${f.detail ? ` — ${f.detail}` : ''}`);
  }
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('probe crashed:', e);
  try { db && db.close(); } catch {}
  try { dir && fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
