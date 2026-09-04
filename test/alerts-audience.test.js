/**
 * The audience: who sees which alert, and why.
 *
 * The original failure this file pins down: every dashboard saw every alert.
 * A chef's tablet carried "bill still open" and "table seated 90 min"; the
 * cashier read about kitchen tickets; the barista — the one person who could
 * rescue a tea sitting unaccepted — saw nothing at all, because the rules
 * were audience-mapped by rule alone and every order rule said "kitchen".
 *
 * Three axes decide visibility now, and each gets its own block:
 *   rule_id  — the rule's audience map (handlers/alerts.js RULE_AUDIENCE)
 *   station  — order-stage rows split bar/kitchen/mixed so a drink's breach
 *              rings at the bar
 *   target   — pickup pings aim at one person (the table's waiter, else the
 *              order's creator); a targeted row is nobody else's to read
 *
 * The sweep block runs against real SQLite through the local adapter, the
 * same discipline outbox.test.js follows: a mocked env would only prove the
 * sweep calls the mock, not that the rows it writes carry the station and
 * target the audience filter routes on.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openLocalD1 } from '../local/d1.js';
import { applySchema } from '../local/env.js';
import { d1Query, d1Run } from '../src/lib/db.js';
import {
  alertVisibleTo,
  allowedRuleIdsForRole,
  runAlertSweep,
} from '../src/handlers/alerts.js';
import {
  orderStation,
  evaluateOrderReadyNow,
  DRINK_WORDS,
  nameIsDrink,
  STATION,
} from '../src/lib/rules.js';

const auth = (role, staffId = '') => ({ sessionRole: role, staff_id: staffId });
const row = (over = {}) => ({
  rule_id: 'order-preparing-too-long',
  entity_type: 'order',
  entity_id: 'o1',
  station: 'kitchen',
  target_staff_id: '',
  ...over,
});

describe('orderStation — which station owns the ticket', () => {
  it('routes an all-drink ticket to the bar', () => {
    expect(orderStation({ items: JSON.stringify([{ name: 'Macchiato' }, { name: 'Tea' }]) })).toBe(STATION.BAR);
    expect(orderStation({ items: '2x Latte [oat-milk], 1x Espresso' })).toBe(STATION.BAR);
  });

  it('routes an all-food ticket to the kitchen', () => {
    expect(orderStation({ items: JSON.stringify([{ name: 'Fut breakfast Gebeta' }]) })).toBe(STATION.KITCHEN);
    expect(orderStation({ items: '1x Chechebesa, 2x Doro Wat' })).toBe(STATION.KITCHEN);
  });

  it('marks a ticket both stations hold as mixed', () => {
    expect(orderStation({ items: '1x Latte, 1x Fut breakfast Gebeta' })).toBe(STATION.MIXED);
  });

  it('returns empty for free-text legacy rows nobody can parse', () => {
    expect(orderStation({ items: 'the usual for the morning shift' })).toBe(STATION.NONE);
    expect(orderStation({ items: null })).toBe(STATION.NONE);
    expect(orderStation({})).toBe(STATION.NONE);
  });

  it('judges "drink" the same way the boards do', () => {
    // Pinned pairs: if the POS word list and this one drift apart, a ticket
    // the boards route to the bar would have its alert land in the kitchen.
    for (const drink of ['Tea', 'Latte', 'Espresso', 'Fresh Juice', 'Sparkling Water', 'Iced Mocha']) {
      expect(nameIsDrink(drink), `${drink} should read as a drink`).toBe(true);
    }
    for (const food of ['Fut breakfast Gebeta', 'Doro Wat', 'Chechebesa', 'Burger', 'Salad']) {
      expect(nameIsDrink(food), `${food} should not read as a drink`).toBe(false);
    }
  });
});

describe('evaluateOrderReadyNow — the instant pickup ping', () => {
  it('fires the moment an order is ready, naming the assigned waiter', () => {
    const v = evaluateOrderReadyNow({
      id: 'o1', status: 'ready', table_id: 'T-04',
      items: JSON.stringify([{ name: 'Fut breakfast Gebeta' }]),
      table_server: 'Abel Tesfaye',
    });
    expect(v.rule_id).toBe('order-ready-now');
    expect(v.station).toBe(STATION.KITCHEN);
    expect(v.target_name).toBe('Abel Tesfaye');
    expect(v.message).toContain('Table T-04');
    expect(v.message).toContain('waiter: Abel Tesfaye');
  });

  it('is silent for anything not sitting ready', () => {
    expect(evaluateOrderReadyNow({ id: 'o1', status: 'preparing' })).toBeNull();
    expect(evaluateOrderReadyNow({ id: 'o1', status: 'served' })).toBeNull();
    expect(evaluateOrderReadyNow(null)).toBeNull();
  });
});

describe('alertVisibleTo — the audience matrix', () => {
  it('shows the chef kitchen and mixed tickets, never the bar\'s or the money\'s', () => {
    expect(alertVisibleTo(row({ station: 'kitchen' }), auth('head-chef'))).toBe(true);
    expect(alertVisibleTo(row({ station: 'mixed' }), auth('head-chef'))).toBe(true);
    expect(alertVisibleTo(row({ station: 'bar' }), auth('head-chef'))).toBe(false);
    // Legacy rows (station '') stay with the kitchen — the audience they had.
    expect(alertVisibleTo(row({ station: '' }), auth('head-chef'))).toBe(true);
    expect(alertVisibleTo(row({ rule_id: 'order-served-unpaid', station: '' }), auth('head-chef'))).toBe(false);
    expect(alertVisibleTo(row({ rule_id: 'table-seated-too-long' }), auth('head-chef'))).toBe(false);
  });

  it('shows the barista drink tickets — including the tea nobody accepted', () => {
    expect(alertVisibleTo(row({ station: 'bar' }), auth('barista'))).toBe(true);
    expect(alertVisibleTo(row({ rule_id: 'order-new-unaccepted', station: 'bar' }), auth('barista'))).toBe(true);
    expect(alertVisibleTo(row({ station: 'kitchen' }), auth('barista'))).toBe(false);
    expect(alertVisibleTo(row({ station: 'mixed' }), auth('barista'))).toBe(true);
    expect(alertVisibleTo(row({ rule_id: 'order-served-unpaid' }), auth('barista'))).toBe(false);
  });

  it('delivers a pickup ping to its person, not to the room', () => {
    const ping = { rule_id: 'order-ready-now', entity_type: 'order', entity_id: 'o9', station: 'kitchen' };
    // Untargeted rows broadcast to the floor lead.
    expect(alertVisibleTo(ping, auth('head-waiter', 'w1'))).toBe(true);
    // Targeted rows are for one person.
    expect(alertVisibleTo({ ...ping, target_staff_id: 'w1' }, auth('head-waiter', 'w1'))).toBe(true);
    expect(alertVisibleTo({ ...ping, target_staff_id: 'w2' }, auth('head-waiter', 'w1'))).toBe(false);
    // A takeaway ping aims at the cashier who rung it up.
    expect(alertVisibleTo({ ...ping, target_staff_id: 'c1' }, auth('cashier', 'c1'))).toBe(true);
    expect(alertVisibleTo({ ...ping, target_staff_id: 'c1' }, auth('head-waiter', 'w1'))).toBe(false);
    // The kitchen never reads pings — they made the thing ready.
    expect(alertVisibleTo(ping, auth('head-chef'))).toBe(false);
  });

  it('keeps money with the cashier, the floor with the waiter, people with the manager', () => {
    expect(alertVisibleTo(row({ rule_id: 'order-served-unpaid' }), auth('cashier'))).toBe(true);
    expect(alertVisibleTo(row({ rule_id: 'table-seated-too-long' }), auth('head-waiter'))).toBe(true);
    expect(alertVisibleTo(row({ rule_id: 'reservation-no-show' }), auth('head-waiter'))).toBe(true);
    expect(alertVisibleTo(row({ rule_id: 'employee-forgot-clock-out' }), auth('cashier'))).toBe(false);
    expect(alertVisibleTo(row({ rule_id: 'delivery-ready-unassigned' }), auth('delivery-staff'))).toBe(true);
    expect(alertVisibleTo(row({ rule_id: 'delivery-ready-unassigned' }), auth('head-waiter'))).toBe(false);
    expect(alertVisibleTo(row({ rule_id: 'order-served-unpaid' }), auth('cleaner'))).toBe(false);
  });

  it('always answers to the manager and never to an anonymous caller', () => {
    expect(alertVisibleTo(row({ rule_id: 'anything-unheard-of' }), auth('manager'))).toBe(true);
    expect(alertVisibleTo(row(), auth('manager'))).toBe(true);
    expect(alertVisibleTo(row(), null)).toBe(false);
    expect(alertVisibleTo(row(), auth(''))).toBe(false);
    expect(alertVisibleTo(null, auth('manager'))).toBe(false);
  });
});

describe('allowedRuleIdsForRole — the SQL pre-filter', () => {
  it('returns null for the manager (no WHERE clause), a list otherwise', () => {
    expect(allowedRuleIdsForRole(auth('manager'))).toBeNull();
    const chef = allowedRuleIdsForRole(auth('head-chef'));
    expect(chef).toContain('order-preparing-too-long');
    expect(chef).not.toContain('order-served-unpaid');
  });

  it('gives the barista the same stage rules (the station split does the routing)', () => {
    const barista = allowedRuleIdsForRole(auth('barista'));
    expect(barista).toContain('order-preparing-too-long');
    expect(barista).toContain('order-new-unaccepted');
    expect(barista).not.toContain('table-seated-too-long');
  });

  it('gives a role with no audience an empty list', () => {
    expect(allowedRuleIdsForRole(auth('cleaner'))).toEqual([]);
    expect(allowedRuleIdsForRole(null)).toEqual([]);
  });
});

describe('runAlertSweep — the rows it writes route correctly', () => {
  let dir, db, env;

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

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fufut-audience-'));
    const opened = openLocalD1(path.join(dir, 'test.sqlite'));
    db = opened.db;
    applySchema(db);
    db.exec(ALERTS_SQL);
    env = { DB: opened.DB, SITE_ID: 'local' };
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stamps station on order alerts and aims the pickup ping at the table waiter', async () => {
    // A staff member and the table assigned to them.
    await d1Run(env, "INSERT INTO staff (id, firstName, lastName, role) VALUES ('w1', 'Abel', 'Tesfaye', 'head-waiter')");
    await d1Run(
      env,
      "INSERT INTO tables (id, number, name, status, server) VALUES ('t-uuid-4', '4', 'Table 4', 'occupied', 'Abel Tesfaye')"
    );

    const nowIso = new Date().toISOString();
    const stale = new Date(Date.now() - 30 * 60000).toISOString(); // 30 min — past every stage limit
    // A tea ticket nobody accepted for half an hour (bar), food cooking too
    // long (kitchen), and food gone ready on Abel's table (the ping).
    await d1Run(
      env,
      "INSERT INTO orders (id, status, type, items, created, updated_at) VALUES ('ord-tea', 'new', 'dine-in', ?, ?, ?)",
      [JSON.stringify([{ name: 'Tea' }]), stale, stale]
    );
    await d1Run(
      env,
      "INSERT INTO orders (id, status, type, items, created, updated_at, preparing_at) VALUES ('ord-food', 'preparing', 'dine-in', ?, ?, ?, ?)",
      [JSON.stringify([{ name: 'Doro Wat' }]), stale, stale, stale]
    );
    await d1Run(
      env,
      "INSERT INTO orders (id, status, type, items, table_id, created, updated_at, ready_at) VALUES ('ord-ready', 'ready', 'dine-in', ?, 'T-4', ?, ?, ?)",
      [JSON.stringify([{ name: 'Fut breakfast Gebeta' }]), nowIso, nowIso, nowIso]
    );

    const result = await runAlertSweep(env);
    expect(result.skipped).toBe(false);
    expect(result.raised).toBeGreaterThanOrEqual(3);

    const tea = (await d1Query(env, "SELECT * FROM alerts WHERE entity_id = 'ord-tea'")).results[0];
    expect(tea.rule_id).toBe('order-new-unaccepted');
    expect(tea.station).toBe('bar');

    const food = (await d1Query(env, "SELECT * FROM alerts WHERE entity_id = 'ord-food'")).results[0];
    expect(food.station).toBe('kitchen');

    const ping = (await d1Query(env, "SELECT * FROM alerts WHERE entity_id = 'ord-ready' AND rule_id = 'order-ready-now'")).results[0];
    expect(ping.station).toBe('kitchen');
    expect(ping.target_staff_id).toBe('w1');
    expect(ping.message).toContain('waiter: Abel Tesfaye');

    // The audience filter reads exactly what the sweep wrote: the ping is
    // Abel's alone, the tea's breach is the barista's, the food's is the chef's.
    expect(alertVisibleTo(ping, auth('head-waiter', 'w1'))).toBe(true);
    expect(alertVisibleTo(ping, auth('head-waiter', 'w2'))).toBe(false);
    expect(alertVisibleTo(tea, auth('barista'))).toBe(true);
    expect(alertVisibleTo(tea, auth('head-chef'))).toBe(false);
    expect(alertVisibleTo(food, auth('head-chef'))).toBe(true);
  });

  it('resolves the pickup ping when the ticket is served', async () => {
    const nowIso = new Date().toISOString();
    await d1Run(
      env,
      "INSERT INTO orders (id, status, type, items, created, updated_at, ready_at) VALUES ('ord-ready', 'ready', 'dine-in', ?, ?, ?, ?)",
      [JSON.stringify([{ name: 'Tea' }]), nowIso, nowIso, nowIso]
    );
    await runAlertSweep(env);
    let ping = (await d1Query(env, "SELECT * FROM alerts WHERE entity_id = 'ord-ready' AND rule_id = 'order-ready-now'")).results[0];
    expect(ping.status).toBe('open');

    // Served — the floor answered. The next sweep must put the ping down.
    await d1Run(env, "UPDATE orders SET status = 'fulfilled' WHERE id = 'ord-ready'");
    await runAlertSweep(env);
    ping = (await d1Query(env, "SELECT * FROM alerts WHERE entity_id = 'ord-ready' AND rule_id = 'order-ready-now'")).results[0];
    expect(ping.status).toBe('resolved');
  });

  it('does not re-raise an acknowledged ping while the condition holds', async () => {
    const nowIso = new Date().toISOString();
    await d1Run(
      env,
      "INSERT INTO orders (id, status, type, items, created, updated_at, ready_at) VALUES ('ord-ready', 'ready', 'dine-in', ?, ?, ?, ?)",
      [JSON.stringify([{ name: 'Tea' }]), nowIso, nowIso, nowIso]
    );
    await runAlertSweep(env);
    await d1Run(env, "UPDATE alerts SET status = 'acknowledged' WHERE entity_id = 'ord-ready' AND rule_id = 'order-ready-now'");
    const result = await runAlertSweep(env);
    expect(result.raised).toBe(0);
    const ping = (await d1Query(env, "SELECT * FROM alerts WHERE entity_id = 'ord-ready' AND rule_id = 'order-ready-now'")).results[0];
    expect(ping.status).toBe('acknowledged');
  });
});

describe('the word list is pinned', () => {
  it('is the same regex shape the POS boards use', () => {
    // lib/drinks.js in the POS carries this exact list; the two must move
    // together or a board and its alerts disagree about whose ticket it is.
    expect(DRINK_WORDS.source).toContain('cappuccino');
    expect(DRINK_WORDS.source).toContain('\\btea\\b');
    expect(DRINK_WORDS.source).toContain('lemonade');
  });
});

describe('runAlertSweep before migration 026 — the deploy cannot wait for a human', () => {
  it('keeps raising and resolving alerts without the station columns', async () => {
    // Fresh module instance: the column probe caches per isolate, and the
    // sweeps above ran against the post-migration shape.
    vi.resetModules();
    const fresh = await import('../src/handlers/alerts.js');

    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'fufut-pre026-'));
    try {
      const opened = openLocalD1(path.join(dir2, 'test.sqlite'));
      const db2 = opened.db;
      applySchema(db2);
      // The pre-026 alerts table: no station, no target.
      db2.exec(`
        CREATE TABLE alerts (
          id TEXT PRIMARY KEY, rule_id TEXT NOT NULL,
          severity TEXT NOT NULL DEFAULT 'warning',
          entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
          entity_label TEXT, message TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open', created TEXT NOT NULL,
          acknowledged_at TEXT, acknowledged_by TEXT,
          resolved_at TEXT, updated_at TEXT
        )`);
      const env2 = { DB: opened.DB, SITE_ID: 'local' };

      const stale = new Date(Date.now() - 30 * 60000).toISOString();
      await d1Run(
        env2,
        "INSERT INTO orders (id, status, type, items, created, updated_at) VALUES ('ord-tea', 'new', 'dine-in', ?, ?, ?)",
        [JSON.stringify([{ name: 'Tea' }]), stale, stale]
      );

      const result = await fresh.runAlertSweep(env2);
      expect(result.skipped).toBe(false);
      expect(result.raised).toBeGreaterThanOrEqual(1);

      const row = (await d1Query(env2, "SELECT * FROM alerts WHERE entity_id = 'ord-tea'")).results[0];
      expect(row.rule_id).toBe('order-new-unaccepted');
      expect(row.station).toBeUndefined();

      // And the audience filter still routes the legacy row: station '' lands
      // in the kitchen bucket, so the chef hears it and the barista does not —
      // exactly the pre-split behaviour, kept working until the migration lands.
      expect(fresh.alertVisibleTo(row, { sessionRole: 'head-chef' })).toBe(true);
      expect(fresh.alertVisibleTo(row, { sessionRole: 'barista' })).toBe(false);
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });
});
