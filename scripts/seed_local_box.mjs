/**
 * seed_local_box.mjs — prepare a local API data dir for the Flutter web E2E:
 * schema, open till, menu (drinks + food), tables, and the staff accounts the
 * walkthrough signs in as. Refuses to touch anything but its own data dir.
 *
 * Run:  node scripts/seed_local_box.mjs /tmp/fufut-e2e-box
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLocalEnv } from '../local/env.js';
import { hashPassword } from '../src/lib/crypto.js';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/seed_local_box.mjs <data-dir>');
  process.exit(1);
}
fs.mkdirSync(dir, { recursive: true });

// createLocalEnv owns the schema bootstrap (same path the server uses), so
// the seed lands in fufut.sqlite exactly the way the box expects it.
const { db } = createLocalEnv({ dir, quiet: true });

const nowIso = new Date().toISOString();
db.prepare(
  "INSERT INTO cashdrawers (id, opened_at, opening_balance, cash_sales, status, created) VALUES ('CD-e2e', ?, 0, 0, 'open', ?)"
).run(nowIso, nowIso);

db.prepare("INSERT INTO categories (id, name, sort_order) VALUES ('C-hot', 'HOT DRINKS', 1)").run();
db.prepare("INSERT INTO categories (id, name, sort_order) VALUES ('C-food', 'MAIN DISHES', 2)").run();
const menu = [
  ['MI-latte', 'C-hot', 'Latte', 60],
  ['MI-esp', 'C-hot', 'Espresso', 45],
  ['MI-ginger', 'C-hot', 'Ginger with Honey', 55],
  ['MI-firfir', 'C-food', 'Firfir', 140],
  ['MI-gebeta', 'C-food', 'Fut Breakfast Gebeta', 160],
  ['MI-tibs', 'C-food', 'Tibs', 260],
];
for (const [id, cat, name, price] of menu) {
  db.prepare("INSERT INTO menu_items (id, category_id, name, price, available) VALUES (?, ?, ?, ?, 1)").run(id, cat, name, price);
}

for (let n = 1; n <= 10; n++) {
  db.prepare(
    "INSERT INTO tables (id, number, name, capacity, section, status, guests) VALUES (?, ?, ?, ?, 'main', 'available', 0)"
  ).run(String(n), n, `T${n}`, n % 2 ? 4 : 6);
}

const PW = 'E2e#2026pass';
const hash = await hashPassword(PW);
const staff = [
  ['S-ma', 'Box', 'Manager', 'ma@e2e.local', 'manager'],
  ['S-hw', 'Yonas', 'Floor', 'hw@e2e.local', 'head-waiter'],
  ['S-ba', 'Bean', 'Bar', 'ba@e2e.local', 'barista'],
  ['S-hc', 'Chef', 'Line', 'hc@e2e.local', 'head-chef'],
  ['S-ca', 'Cash', 'Till', 'ca@e2e.local', 'cashier'],
];
for (const [id, first, last, email, role] of staff) {
  db.prepare(
    `INSERT INTO staff (id, firstName, lastName, email, role, status, password_hash, must_change_password, created)
     VALUES (?, ?, ?, ?, ?, 'active', ?, 0, ?)`
  ).run(id, first, last, email, role, hash, nowIso);
}

console.log(`seeded ${dir}`);
console.log('staff: ma@e2e.local / hw@e2e.local / ba@e2e.local / hc@e2e.local / ca@e2e.local — password E2e#2026pass');
db.close();
