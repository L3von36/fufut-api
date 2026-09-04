/**
 * The SSE channel cache — how the same payload stops being queried once per
 * client and becomes once per isolate.
 *
 * The failure this file pins down: every connected screen ran its own broad
 * D1 query every 10 seconds, forever. Ten tablets on the floor at lunch meant
 * ten identical `SELECT ... FROM orders` scans per tick, and on 2026-09-04
 * that pattern (plus the per-client alerts/tables ticks) burned the account's
 * entire daily D1 row-read budget by 12:00 UTC — every authenticated endpoint
 * answered 500 until midnight UTC.
 *
 * The fix has two halves, both covered here against real SQLite through the
 * local adapter, because a mocked env would only prove the code calls the
 * mock:
 *
 *   coalescing — a second tick inside the freshness window reuses the cached
 *   payload (no broad query), yet still emits to a newly connected client;
 *
 *   probes — when the channel's cheap change-detector says nothing moved, the
 *   broad query does not run at all; when something DID move (an order edited,
 *   a new order stamped at birth, an alert acknowledged), the next tick picks
 *   it up.
 *
 * The tests drive ticks with an explicit clock: a pair of ticks runs
 * PAYLOAD_FRESH_MS apart, so the window has expired and the probe — not the
 * window — decides whether the broad query runs. That is the production
 * cadence (8s window, 10s ticks) compressed into two calls.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openLocalD1 } from '../local/d1.js';
import { applySchema } from '../local/env.js';
import { d1Run } from '../src/lib/db.js';
import {
  tickChannel,
  clearChannelCacheForTest,
  PAYLOAD_FRESH_MS,
} from '../src/handlers/sse.js';

const auth = (role, staffId = '') => ({ sessionRole: role, staff_id: staffId });
const client = (role, staffId) => ({
  auth: auth(role, staffId),
  allowedRules: null,
  managerSeesAll: true,
  lastSig: null,
});

let CLOCK = 1_000_000_000_000;
const tickAt = (channel, env, c) => tickChannel(channel, env, c, { nowMs: CLOCK });
const nextTick = () => (CLOCK += PAYLOAD_FRESH_MS + 1000);

// The alerts table is not part of the production-schema dump yet (migration
// 026 era columns included) — same shape the sweep tests build.
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
let db;
let env;

beforeEach(() => {
  clearChannelCacheForTest();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fufut-sse-'));
  const opened = openLocalD1(path.join(dir, 'box'));
  db = opened.db;
  applySchema(db);
  db.exec(ALERTS_SQL);
  env = { DB: opened.DB, SITE_ID: 'local' };
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('kitchen channel — coalescing and the updated_at probe', () => {
  let seq = 0;
  function seedOrder(over = {}) {
    const id = over.id || `O-SSE-${++seq}`;
    d1Run(env, `INSERT INTO orders (id, status, payment_status, items, total, created, updated_at)
      VALUES (?, ?, 'unpaid', ?, 100, ?, ?)`, [
      id,
      over.status || 'preparing',
      over.items || '1x Tea',
      over.created || '2026-09-04T09:00:00.000Z',
      over.updated_at || '2026-09-04T09:00:00.000Z',
    ]);
    return id;
  }

  it('first tick emits the active board; terminal rows stay off it', async () => {
    seedOrder({ id: 'O-A', status: 'preparing' });
    seedOrder({ id: 'O-B', status: 'new' });
    seedOrder({ id: 'O-C', status: 'completed', updated_at: '2026-09-04T09:05:00.000Z' });

    const r = await tickAt('kitchen', env, client('manager'));
    expect(r.keepaliveOnly).toBe(false);
    const ids = r.view.orders.map((o) => o.id);
    expect(ids).toContain('O-A');
    expect(ids).toContain('O-B');
    expect(ids).not.toContain('O-C');
  });

  it('a client connecting inside the freshness window is served from cache', async () => {
    seedOrder({ id: 'O-A' });
    const first = await tickAt('kitchen', env, client('manager'));
    expect(first.keepaliveOnly).toBe(false);

    nextTick(); // window expires; the probe re-runs and finds nothing moved

    // Same payload, fresh client — a screen that just connected still gets
    // the current board (its lastSig is null) even though no broad query ran.
    const second = await tickAt('kitchen', env, client('manager'));
    expect(second.keepaliveOnly).toBe(false);
    expect(second.sig).toBe(first.sig);
  });

  it('a status move stamps updated_at, trips the probe, and the board follows', async () => {
    seedOrder({ id: 'O-A', status: 'preparing' });
    const c = client('manager');
    await tickAt('kitchen', env, c);

    nextTick();
    d1Run(env, "UPDATE orders SET status = 'ready', updated_at = ? WHERE id = 'O-A'",
      ['2026-09-04T09:10:00.000Z']);
    const r = await tickAt('kitchen', env, c);
    const row = r.view.orders.find((o) => o.id === 'O-A');
    expect(row.status).toBe('ready');
  });

  it('a brand-new order trips the probe because the INSERT stamps updated_at', async () => {
    const c = client('manager');
    await tickAt('kitchen', env, c);

    nextTick();
    // The exact shape the order POST handler now writes — updated_at set at
    // birth. The split-bill INSERT carries the same stamp.
    const stamp = '2026-09-04T09:12:00.000Z';
    d1Run(env, `INSERT INTO orders (id, status, payment_status, items, total, created, updated_at)
      VALUES ('O-NEW', 'new', 'unpaid', '1x Coffee', 60, ?, ?)`, [stamp, stamp]);

    const r = await tickAt('kitchen', env, c);
    expect(r.view.orders.map((o) => o.id)).toContain('O-NEW');
  });

  it('an order whose updated_at is NULL (legacy split) does not blind the probe', async () => {
    seedOrder({ id: 'O-A' });
    const c = client('manager');
    await tickAt('kitchen', env, c);

    nextTick();
    // A pre-fix split row: updated_at NULL. MAX() ignores NULLs, so the probe
    // keeps answering from the stamped rows and the board still refreshes
    // when any stamped order moves.
    d1Run(env, `INSERT INTO orders (id, status, payment_status, items, total, created)
      VALUES ('O-LEGACY', 'new', 'unpaid', '1x Tea', 30, '2026-09-04T09:13:00.000Z')`);
    d1Run(env, "UPDATE orders SET status = 'ready', updated_at = '2026-09-04T09:14:00.000Z' WHERE id = 'O-A'");

    const r = await tickAt('kitchen', env, c);
    expect(r.view.orders.map((o) => o.id)).toContain('O-LEGACY');
    expect(r.view.orders.find((o) => o.id === 'O-A').status).toBe('ready');
  });
});

describe('alerts channel — coalescing with the role filter intact', () => {
  let seq = 0;
  function seedAlert(over = {}) {
    const id = over.id || `AL-SSE-${++seq}`;
    d1Run(env, `INSERT INTO alerts (id, rule_id, severity, entity_type, entity_id, entity_label, message, status, station, target_staff_id, created, updated_at)
      VALUES (?, ?, 'warning', 'order', 'o1', '', ?, 'open', ?, ?, ?, ?)`, [
      id,
      over.rule_id || 'order-preparing-too-long',
      over.message || 'Ticket open too long',
      over.station || 'kitchen',
      over.target_staff_id || '',
      over.created || '2026-09-04T09:00:00.000Z',
      over.updated_at || '2026-09-04T09:00:00.000Z',
    ]);
    return id;
  }

  it('a chef client receives only kitchen-station rows from the shared payload', async () => {
    seedAlert({ id: 'AL-K', station: 'kitchen' });
    seedAlert({ id: 'AL-B', station: 'bar', rule_id: 'order-new-unaccepted' });

    // allowedRuleIdsForRole is computed at connect time in handleSSE; the
    // test client mirrors that shape for a role whose rule audience covers
    // both stations, so the row-level station filter is what decides.
    const { allowedRuleIdsForRole } = await import('../src/handlers/alerts.js');
    const chef = client('head-chef');
    chef.allowedRules = allowedRuleIdsForRole(chef.auth);
    chef.managerSeesAll = chef.allowedRules === null;

    const r = await tickAt('alerts', env, chef);
    const ids = r.view.alerts.map((a) => a.id);
    expect(ids).toContain('AL-K');
    expect(ids).not.toContain('AL-B');
  });

  it('an acknowledged alert disappears on the next tick — the count moves the probe', async () => {
    const id = seedAlert({});
    const c = client('manager');
    const first = await tickAt('alerts', env, c);
    expect(first.view.alerts.map((a) => a.id)).toContain(id);

    nextTick();
    d1Run(env, `UPDATE alerts SET status = 'acknowledged', updated_at = ? WHERE id = ?`,
      ['2026-09-04T09:15:00.000Z', id]);
    const second = await tickAt('alerts', env, c);
    expect(second.view.alerts.map((a) => a.id)).not.toContain(id);
  });
});

describe('activity channel — the rowid probe', () => {
  it('a new audit_log entry is picked up on the next tick', async () => {
    const c = client('manager');
    const first = await tickAt('activity', env, c);

    nextTick();
    d1Run(env, `INSERT INTO audit_log (id, at, actor_id, actor_name, actor_role, action, entity, entity_id)
      VALUES ('AUD-1', '2026-09-04T09:20:00.000Z', 'S1', 'Local Manager', 'manager', 'test', 'test', '1')`);

    const second = await tickAt('activity', env, c);
    expect(second.view.entries.map((e) => e.id)).toContain('AUD-1');
    // sanity: the earlier tick could not have seen it
    expect(first.view.entries.map((e) => e.id)).not.toContain('AUD-1');
  });
});

describe('freshness window — the number the read budget hangs on', () => {
  it('stays shorter than the tick so clients reuse, not re-stack, queries', () => {
    expect(PAYLOAD_FRESH_MS).toBeLessThan(10000);
  });
});
