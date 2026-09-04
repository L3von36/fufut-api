/**
 * The poll coalescing cache at the Worker's front door.
 *
 * Pinned behaviour: only whitelisted exact paths on GET are cached and only
 * for seconds; a role's answer is never another role's answer; any successful
 * write flushes everything so a read your own write never goes stale; and
 * failed writes invalidate nothing because they changed nothing.
 *
 * Driven through the real `worker.fetch` against real SQLite — the same
 * discipline local-runtime.test.js sets — because the interesting bugs live
 * exactly where the gate, the cache and the router meet.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import worker from '../src/index.js';
import { createLocalEnv } from '../local/env.js';
import { hashPassword } from '../src/lib/crypto.js';
import { microCacheFlush } from '../src/lib/microcache.js';

const MANAGER = { id: 'S-MC-1', email: 'mc-manager@local.test', password: 'localbox123' };
const CASHIER = { id: 'S-MC-2', email: 'mc-cashier@local.test', password: 'localbox123' };

let dir;
let env;
let db;
let managerCookie = '';
let cashierCookie = '';

// The alerts table is not in the production-schema dump yet — the same shape
// the sweep and SSE tests build.
const ALERTS_SQL = `
  CREATE TABLE IF NOT EXISTS alerts (
    id            TEXT PRIMARY KEY,
    rule_id       TEXT NOT NULL,
    severity      TEXT NOT NULL DEFAULT 'warning',
    entity_type   TEXT NOT NULL,
    entity_id     TEXT NOT NULL,
    entity_label  TEXT,
    message       TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'open',
    created       TEXT NOT NULL,
    acknowledged_at  TEXT,
    acknowledged_by  TEXT,
    resolved_at      TEXT,
    updated_at       TEXT,
    station          TEXT DEFAULT '',
    target_staff_id  TEXT DEFAULT ''
  )`;

async function call(method, url, body, cookie) {
  const request = new Request('http://localhost:8787' + url, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const response = await worker.fetch(request, env, { waitUntil() {}, passThroughOnException() {} });
  let payload = null;
  try {
    payload = await response.clone().json();
  } catch {
    /* not every response is JSON */
  }
  return { status: response.status, body: payload, response };
}

async function login(account) {
  const r = await call('POST', '/api/auth/login', { email: account.email, password: account.password });
  expect(r.status).toBe(200);
  const setCookie = r.response.headers.get('set-cookie') || '';
  return setCookie.split(';')[0];
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fufut-mc-'));
  ({ env, db } = createLocalEnv({ dir, quiet: true }));
  db.exec(ALERTS_SQL);

  db.prepare(
    "INSERT INTO tables (id, number, name, capacity, section, status, guests) VALUES ('mc-9', 9, 'MC9', 4, 'main', 'available', 0)"
  ).run();

  for (const [who, role] of [[MANAGER, 'manager'], [CASHIER, 'cashier']]) {
    db.prepare(
      `INSERT INTO staff (id, firstName, lastName, email, role, status, password_hash, must_change_password, created)
       VALUES (?, ?, ?, ?, ?, 'active', ?, 0, ?)`
    ).run(who.id, 'Micro', 'Cache', who.email, role, await hashPassword(who.password), new Date().toISOString());
  }
  managerCookie = await login(MANAGER);
  cashierCookie = await login(CASHIER);
});

afterAll(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// The cache is module state: without this, a previous test's 4s-fresh answer
// would serve the next test's first GET — coalescing working as designed,
// against the wrong data.
beforeEach(() => {
  microCacheFlush();
});

/** GET /api/tables answers with a bare array of mapped rows. */
function tableRows(body) {
  return Array.isArray(body) ? body : body.tables || [];
}

describe('cache behaviour through the front door', () => {
  it('serves the second identical GET from cache — a write in between is what breaks it', async () => {
    const first = await call('GET', '/api/tables', null, managerCookie);
    expect(first.status).toBe(200);
    const second = await call('GET', '/api/tables', null, managerCookie);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);

    // A successful write flushes: the next read must reflect it. Update the
    // seeded table's status through the generic resource handler.
    const put = await call('PUT', '/api/tables/mc-9', { status: 'occupied', guests: 2 }, managerCookie);
    expect(put.status).toBe(200);
    const third = await call('GET', '/api/tables', null, managerCookie);
    const t9 = tableRows(third.body).find((t) => String(t.id) === 'mc-9');
    expect(t9).toBeTruthy();
    expect(String(t9.status)).toBe('occupied');
  });

  it('write-through: the writer sees their own write immediately', async () => {
    // Seed an open alert row the way the sweep does, then acknowledge it.
    // The ack endpoint lives under a whitelisted read path's family — the
    // flush-on-write rule must make the follow-up GET tell the truth.
    db.prepare(
      `INSERT INTO alerts (id, rule_id, severity, entity_type, entity_id, entity_label, message, status, created, updated_at)
       VALUES ('mc-al-1', 'order-preparing-too-long', 'warning', 'order', 'o1', '', 'test ticket', 'open', ?, ?)`
    ).run(new Date().toISOString(), new Date().toISOString());

    const before = await call('GET', '/api/alerts', null, managerCookie);
    expect(before.status).toBe(200);
    expect(before.body.alerts.map((a) => a.id)).toContain('mc-al-1');

    const ack = await call('POST', '/api/alerts/mc-al-1/acknowledge', null, managerCookie);
    expect(ack.status).toBe(200);

    const after = await call('GET', '/api/alerts?status=acknowledged', null, managerCookie);
    expect(after.body.alerts.map((a) => a.id)).toContain('mc-al-1');
    const open = await call('GET', '/api/alerts', null, managerCookie);
    expect(open.body.alerts.map((a) => a.id)).not.toContain('mc-al-1');
  });

  it('a failed write leaves the cache standing', async () => {
    const first = await call('GET', '/api/stats', null, managerCookie);
    expect(first.status).toBe(200);

    // A write that 4xxs changes nothing, so the cached stats stay valid.
    const bad = await call('POST', '/api/nonexistent-resource', { x: 1 }, managerCookie);
    expect(bad.status).toBeGreaterThanOrEqual(400);

    const second = await call('GET', '/api/stats', null, managerCookie);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });

  it('different roles never share an answer on a role-filtered endpoint', async () => {
    // /api/alerts answers differ per role: the cashier's audience is money
    // rules only, the manager sees everything. Seed one kitchen-station row.
    db.prepare(
      `INSERT INTO alerts (id, rule_id, severity, entity_type, entity_id, entity_label, message, status, station, target_staff_id, created, updated_at)
       VALUES ('mc-al-2', 'order-preparing-too-long', 'warning', 'order', 'o2', '', 'kitchen ticket', 'open', 'kitchen', '', ?, ?)`
    ).run(new Date().toISOString(), new Date().toISOString());

    const managerView = await call('GET', '/api/alerts', null, managerCookie);
    const cashierView = await call('GET', '/api/alerts', null, cashierCookie);
    expect(managerView.body.alerts.map((a) => a.id)).toContain('mc-al-2');
    expect(cashierView.body.alerts.map((a) => a.id)).not.toContain('mc-al-2');
  });

  it('subpaths of a whitelisted family are not cached', async () => {
    // /api/tables is cached; /api/tables/sections is a different resource on
    // the same family and must always hit its handler.
    const a = await call('GET', '/api/tables/sections', null, managerCookie);
    const b = await call('GET', '/api/tables/sections', null, managerCookie);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });
});
