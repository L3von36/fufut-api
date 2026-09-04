/**
 * The D1 quota circuit breaker.
 *
 * The outage this file pins down: 2026-09-04, 5.29M rows read by 12:00 UTC —
 * the free tier's whole day — and every authenticated endpoint answered the
 * raw Worker exception "error code: 1101" until midnight, with nobody able to
 * see how close it was coming. The breaker makes the burn visible (an exact
 * counter fed by every D1 response's meta.rows_read), persisted (a per-day KV
 * key that survives isolate death), and actionable (a four-rung mode ladder
 * that sheds freshness and convenience before it ever sheds the till).
 *
 * Pinned behaviour, driven through the real worker.fetch against real SQLite
 * and the local KV adapter wherever the front door is involved:
 *
 *   counting — rows read on the request path land in the day estimate;
 *   ladder   — the day total from KV selects normal/conserve/emergency/
 *              critical, with a manager override trumping the meter;
 *   health   — /api/health answers 200 with the meter while D1 is DEAD, and
 *              only a manager's session widens it with operational detail;
 *   shed     — at critical, GET /api/reports answers 503 before a single
 *              statement is prepared;
 *   survive  — an unhandled handler exception leaves as parseable JSON, not
 *              the raw text the staff saw during the outage;
 *   pace     — the cron's D1 sweeps throttle with the ladder and stop at
 *              critical (the KV-only content publish never does);
 *   sse      — the shared payload's freshness window stretches x4 in
 *              conserve, x8 in emergency, and stops refreshing entirely in
 *              critical: the board freezes instead of going blank.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import worker from '../src/index.js';
import { createLocalEnv, applySchema } from '../local/env.js';
import { openLocalD1 } from '../local/d1.js';
import { hashPassword } from '../src/lib/crypto.js';
import { d1Query, d1Batch } from '../src/lib/db.js';
import { microCacheFlush } from '../src/lib/microcache.js';
import {
  MODES,
  countRowsRead,
  quotaResetForTest,
  refreshQuota,
  quotaSnapshot,
  quotaTick,
  setModeOverride,
  clearModeOverride,
  getModeSync,
  cronShouldSweep,
  freshnessMultiplier,
  cacheTtlMultiplier,
} from '../src/lib/quota.js';
import { tickChannel, clearChannelCacheForTest, PAYLOAD_FRESH_MS } from '../src/handlers/sse.js';

const MANAGER = { id: 'S-QU-1', email: 'qu-manager@local.test', password: 'localbox123' };
const CASHIER = { id: 'S-QU-2', email: 'qu-cashier@local.test', password: 'localbox123' };

const dayKey = () => 'quota:day:' + new Date().toISOString().slice(0, 10);

// The alerts table is not in the production-schema dump yet — the same shape
// the sweep, microcache and SSE tests build.
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

let dir;
let env;
let db;

/** Wrap a local D1 adapter so tests can count prepared statements. */
function countingDb(DB) {
  const counts = { prepares: 0 };
  const proxied = {
    prepare(sql) {
      counts.prepares += 1;
      return DB.prepare(sql);
    },
    batch(statements) {
      return DB.batch(statements);
    },
  };
  return { proxied, counts };
}

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

async function seedStaffAsync() {
  for (const [who, role] of [[MANAGER, 'manager'], [CASHIER, 'cashier']]) {
    db.prepare(
      `INSERT INTO staff (id, firstName, lastName, email, role, status, password_hash, must_change_password, created)
       VALUES (?, ?, ?, ?, ?, 'active', ?, 0, ?)`
    ).run(who.id, 'Quota', 'Staff', who.email, role, await hashPassword(who.password), new Date().toISOString());
  }
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fufut-qu-'));
});

beforeEach(() => {
  quotaResetForTest();
  microCacheFlush();
  clearChannelCacheForTest();
  // A fresh DATABASE per test, not merely a fresh wrapper: the local env
  // persists its SQLite file inside dir, so a shared dir would carry seeded
  // staff rows and KV overrides (a previous test's 'critical' pin!) into the
  // next test — the breaker persisting by design, against the wrong scenario.
  ({ env, db } = createLocalEnv({ dir: path.join(dir, 't-' + Math.random().toString(36).slice(2)), quiet: true }));
  db.exec(ALERTS_SQL);
});

afterAll(() => {
  if (db) db.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('counting: meta.rows_read reaches the breaker', () => {
  it('d1Query counts the rows a statement actually returned', async () => {
    // The local adapter reports rows_read = rows returned — the production
    // adapter reports scanned rows; both flow through the same counter.
    const before = (await quotaSnapshot(env)).rowsRead;
    await d1Query(env, "SELECT name FROM sqlite_master WHERE type = 'table'");
    const after = (await quotaSnapshot(env)).rowsRead;
    expect(after).toBeGreaterThan(before);
  });

  it('a request-path read shows up in the day estimate', async () => {
    // /api/stats is public and reads D1 — a real request-path read.
    const stats = await call('GET', '/api/stats');
    expect(stats.status).toBe(200);
    const snap = await quotaSnapshot(env);
    expect(snap.rowsRead).toBeGreaterThan(0);
    expect(snap.mode).toBe('normal');
  });

  it('a batch is counted statement by statement', async () => {
    const fake = {
      batch: async () => [
        { meta: { rows_read: 5 } },
        { meta: { rows_read: 7 } },
        { results: [] }, // a result without meta counts zero, not NaN
      ],
      prepare: () => ({ bind: () => ({}) }),
    };
    await d1Batch({ DB: fake }, [
      { sql: 'SELECT 1' },
      { sql: 'SELECT 2' },
      { sql: 'SELECT 3' },
    ]);
    const snap = await quotaSnapshot({}); // no KV: the local estimate stands
    expect(snap.rowsRead).toBe(12);
  });

  it('the local count flushes into the day key on the tick', async () => {
    countRowsRead(250_000); // >= FLUSH_DELTA_ROWS
    await quotaTick(env, null);
    const raw = await env.CONTENT_KV.get(dayKey());
    expect(raw).toBeTruthy();
    expect(Number(JSON.parse(raw).reads)).toBeGreaterThanOrEqual(250_000);
  });
});

describe('the mode ladder', () => {
  async function dayReadsAt(rows) {
    await env.CONTENT_KV.put(dayKey(), JSON.stringify({ reads: rows, at: new Date().toISOString() }));
  }

  it('walks normal → conserve → emergency → critical off the KV day total', async () => {
    await dayReadsAt(1_000_000);
    expect(await refreshQuota(env)).toBe('normal');

    quotaResetForTest();
    await dayReadsAt(3_600_000); // 72% of the 5M default budget
    expect(await refreshQuota(env)).toBe('conserve');

    quotaResetForTest();
    await dayReadsAt(4_300_000); // 86%
    expect(await refreshQuota(env)).toBe('emergency');

    quotaResetForTest();
    await dayReadsAt(4_800_000); // 96%
    expect(await refreshQuota(env)).toBe('critical');
  });

  it('a manager override outranks the meter, and auto returns control to it', async () => {
    await env.CONTENT_KV.put(dayKey(), JSON.stringify({ reads: 4_800_000, at: new Date().toISOString() }));
    await refreshQuota(env); // pull the day total into the estimate
    expect(getModeSync()).toBe('critical');

    await setModeOverride(env, 'conserve');
    expect(getModeSync()).toBe('conserve');

    // 'auto' clears the pin: the meter rules again, and at 96% that is
    // critical — exactly what the manager asked to step away from.
    await clearModeOverride(env);
    expect(getModeSync()).toBe('critical');

    // A deliberate 'normal' pin holds even against the meter: the manager's
    // "I do not trust the meter" lever. It lives in KV, so it survives a
    // deploy — protection chosen on purpose stays chosen.
    await setModeOverride(env, 'normal');
    expect(getModeSync()).toBe('normal');

    // An invalid mode is refused rather than silently ignored.
    await expect(setModeOverride(env, 'turbo')).rejects.toThrow(/one of/);
  });

  it('the local estimate fills in while KV has not answered', async () => {
    // No KV in env at all: the breaker must keep working off local counts
    // instead of throwing or freezing at the default.
    countRowsRead(4_900_000);
    expect(getModeSync()).toBe('critical');
  });
});

describe('GET /api/health', () => {
  it('answers anonymously with the meter and no operational detail', async () => {
    const r = await call('GET', '/api/health');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.mode).toBe('normal');
    expect(typeof r.body.rows_read).toBe('number');
    expect(r.body.budget).toBe(5_000_000);
    expect(typeof r.body.pct).toBe('number');
    expect(r.body.resets_at_utc).toBe('00:00');
    expect(r.body.detail).toBeUndefined();
  });

  it('a manager session adds the operational detail block', async () => {
    await seedStaffAsync();
    const cookie = await login(MANAGER);

    const r = await call('GET', '/api/health', null, cookie);
    expect(r.status).toBe(200);
    expect(r.body.detail).toBeTruthy();
    expect(r.body.detail.sseClients).toBeTruthy();
    expect(typeof r.body.detail.localIsolateRows).toBe('number');
  });

  it('stays answerable while D1 is dead — the outage is exactly when it is needed', async () => {
    // A database that throws the quota exception on EVERY statement.
    env.DB = {
      prepare: () => {
        throw new Error('error code: 1101');
      },
      batch: () => {
        throw new Error('error code: 1101');
      },
    };
    const r = await call('GET', '/api/health');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(MODES.includes(r.body.mode)).toBe(true);
  });
});

describe('POST /api/health/mode — the manager’s lever', () => {
  it('refuses anonymous callers and non-managers, honours the manager', async () => {
    await seedStaffAsync();

    const anon = await call('POST', '/api/health/mode', { mode: 'conserve' });
    expect(anon.status).toBe(401);

    const cashierCookie = await login(CASHIER);
    const cashier = await call('POST', '/api/health/mode', { mode: 'conserve' }, cashierCookie);
    expect(cashier.status).toBe(403);

    const cookie = await login(MANAGER);
    const ok = await call('POST', '/api/health/mode', { mode: 'conserve' }, cookie);
    expect(ok.status).toBe(200);
    expect(ok.body.mode).toBe('conserve');
    expect(getModeSync()).toBe('conserve');

    const auto = await call('POST', '/api/health/mode', { mode: 'auto' }, cookie);
    expect(auto.status).toBe(200);
    expect(getModeSync()).toBe('normal'); // meter rules again at a low day total

    const bad = await call('POST', '/api/health/mode', { mode: 'turbo' }, cookie);
    expect(bad.status).toBe(400);
  });
});

describe('the critical-mode shed', () => {
  it('GET /api/reports answers 503 before preparing a single statement', async () => {
    const { proxied, counts } = countingDb(env.DB);
    env.DB = proxied;
    await setModeOverride(env, 'critical');

    const r = await call('GET', '/api/reports/dashboard?period=day');
    expect(r.status).toBe(503);
    expect(r.body.mode).toBe('critical');
    expect(r.body.resets_at_utc).toBe('00:00');
    expect(counts.prepares).toBe(0); // not even a session lookup
  });

  it('other modes let reports through to their handler', async () => {
    const { proxied, counts } = countingDb(env.DB);
    env.DB = proxied;

    const r = await call('GET', '/api/reports/dashboard?period=day');
    // Not 503 — the gate did not fire. (401: anonymous, as designed.)
    expect(r.status).not.toBe(503);
    expect(counts.prepares).toBe(0); // the auth gate stopped it, no reports query ran
    expect(getModeSync()).toBe('normal');
  });
});

describe('the global JSON error net', () => {
  it('an unhandled D1 exception leaves as parseable JSON, not raw text', async () => {
    env.DB = {
      prepare: () => {
        throw new Error('error code: 1101');
      },
    };
    const r = await call('GET', '/api/reviews');
    expect(r.status).toBe(500);
    expect(r.body).toBeTruthy();
    expect(r.body.ok).toBe(false);
    expect(String(r.body.detail)).toContain('1101');
  });

  it('responses carry the X-Fufut-Mode degradation hint', async () => {
    const r = await call('GET', '/api/venue/status');
    expect(r.status).toBe(200);
    expect(r.response.headers.get('x-fufut-mode')).toBe('normal');
  });
});

describe('the cron paces with the ladder', () => {
  it('critical stops the D1 sweeps but not the KV publish check', async () => {
    const { proxied, counts } = countingDb(env.DB);
    env.DB = proxied;
    await setModeOverride(env, 'critical');

    await worker.scheduled({}, env, { waitUntil() {} });
    expect(counts.prepares).toBe(0);
  });

  it('normal mode runs the sweeps', async () => {
    const { proxied, counts } = countingDb(env.DB);
    env.DB = proxied;

    await worker.scheduled({}, env, { waitUntil() {} });
    expect(counts.prepares).toBeGreaterThan(0);
  });

  it('cronShouldSweep alternates in emergency and never fires in critical', async () => {
    await setModeOverride(env, 'emergency');
    const pattern = [cronShouldSweep(), cronShouldSweep(), cronShouldSweep(), cronShouldSweep()];
    expect(pattern).toEqual([false, true, false, true]); // every other minute

    await setModeOverride(env, 'critical');
    expect(cronShouldSweep()).toBe(false);

    await setModeOverride(env, 'normal');
    expect(cronShouldSweep()).toBe(true);
  });
});

describe('SSE freshness scales with the mode', () => {
  const auth = (role) => ({ sessionRole: role, staff_id: '' });
  const clientFor = (role) => ({ auth: auth(role), allowedRules: null, managerSeesAll: true, lastSig: null });

  let CLOCK;
  let sseEnv;
  let sseDb;

  beforeEach(() => {
    const opened = openLocalD1(path.join(dir, 'box-sse-' + Math.random().toString(36).slice(2)));
    sseDb = opened.db;
    applySchema(sseDb);
    sseDb.exec(ALERTS_SQL);
    sseEnv = { DB: opened.DB, SITE_ID: 'local' };
    CLOCK = 1_000_000_000_000;
  });

  function insertOrder(id, updated) {
    sseDb
      .prepare(
        `INSERT INTO orders (id, status, payment_status, items, total, created, updated_at)
         VALUES (?, 'pending', 'unpaid', '1x Tea', 10, ?, ?)`
      )
      .run(id, new Date(CLOCK).toISOString(), updated);
  }

  async function kitchenView() {
    return tickChannel('kitchen', sseEnv, clientFor('manager'), { nowMs: CLOCK });
  }

  it('conserve stretches the 8s window to 32s', async () => {
    await setModeOverride(sseEnv, 'conserve');
    await kitchenView(); // prime the shared payload at CLOCK

    CLOCK += 9_000; // past the normal 8s window, inside conserve's 32s
    insertOrder('q-o1', new Date(CLOCK).toISOString());
    let r = await kitchenView();
    expect(r.view.orders).toHaveLength(0); // frozen: the window has not closed

    CLOCK += 24_000; // 33s past the prime — outside every window
    r = await kitchenView();
    expect(r.view.orders.map((o) => o.id)).toContain('q-o1');
  });

  it('normal mode picks the same change up at the designed 8s cadence', async () => {
    await kitchenView(); // prime
    CLOCK += 9_000;
    insertOrder('q-o2', new Date(CLOCK).toISOString());
    const r = await kitchenView();
    expect(r.view.orders.map((o) => o.id)).toContain('q-o2');
  });

  it('critical freezes the board instead of spending reads', async () => {
    await kitchenView(); // prime at the default mode, then flip
    await setModeOverride(sseEnv, 'critical');

    CLOCK += 60_000;
    insertOrder('q-o3', new Date(CLOCK).toISOString());
    const r = await kitchenView();
    expect(r.keepaliveOnly).toBe(false); // the last payload still flows
    expect(r.view.orders.map((o) => o.id)).not.toContain('q-o3'); // but nothing new is queried

    expect(freshnessMultiplier('critical')).toBe(Infinity);
    expect(freshnessMultiplier('conserve')).toBe(4);
    expect(freshnessMultiplier('normal')).toBe(1);
    expect(cacheTtlMultiplier('emergency')).toBe(8);
  });

  it('the constants the production cadence relies on are unchanged', () => {
    expect(PAYLOAD_FRESH_MS).toBe(8000);
  });
});
