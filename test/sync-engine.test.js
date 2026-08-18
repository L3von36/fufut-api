/**
 * The sync engine — phase 3, both sides at once.
 *
 * Two real databases: one standing in for the box, one for the cloud. The
 * daemon's `fetch` is wired straight to the cloud's Worker, so a push really is
 * a Request travelling through the real authorization gate into the real
 * handler, and a pull really is that handler answering. Nothing about the
 * protocol is stubbed — only the wire is missing.
 *
 * That matters because every interesting failure here is an interaction
 * between the two sides: an echo loop, a cursor that rewinds, a rule applied
 * in one direction but not the other.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import worker from '../src/index.js';
import { createLocalEnv } from '../local/env.js';
import { createSyncEngine } from '../local/sync.js';
import { d1Run } from '../src/lib/db.js';

const TOKEN = 'shared-secret';

let boxDir;
let cloudDir;
let box;
let cloud;
let boxDb;
let cloudDb;
let engine;
let logs;

/** The cloud, reachable without a network. */
function wireToCloud() {
  return async (url, init) => {
    const request = new Request(url, init);
    return worker.fetch(request, cloud, { waitUntil() {}, passThroughOnException() {} });
  };
}

beforeEach(() => {
  boxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fufut-box-'));
  cloudDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fufut-cloud-'));

  ({ env: box, db: boxDb } = createLocalEnv({ dir: boxDir, quiet: true }));
  ({ env: cloud, db: cloudDb } = createLocalEnv({ dir: cloudDir, quiet: true }));

  box.SITE_ID = 'local';
  box.CLOUD_URL = 'http://cloud.test';
  box.SYNC_TOKEN = TOKEN;

  cloud.SITE_ID = 'cloud';
  cloud.SYNC_TOKEN = TOKEN;

  engine = createSyncEngine({ env: box, fetchImpl: wireToCloud() });
  logs = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  boxDb.close();
  cloudDb.close();
  fs.rmSync(boxDir, { recursive: true, force: true });
  fs.rmSync(cloudDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Put an entry in the cloud's journal, as a write on the cloud would. */
function cloudWrote(entity, op, sql, params, entityId) {
  cloudDb
    .prepare('INSERT INTO sync_outbox (entity, entity_id, op, payload, at) VALUES (?, ?, ?, ?, ?)')
    .run(entity, entityId ?? null, op, JSON.stringify({ sql, params }), new Date().toISOString());
}

describe('an order taken on the box reaches the cloud', () => {
  it('pushes what the floor wrote', async () => {
    await d1Run(box, 'INSERT INTO orders (id, items, total, status, type) VALUES (?, ?, ?, ?, ?)', [
      'O-BOX-1', '[]', 260, 'new', 'dine-in',
    ]);

    const result = await engine.runOnce();

    expect(result.online).toBe(true);
    expect(result.pushed).toBe(1);
    expect(cloudDb.prepare("SELECT total FROM orders WHERE id = 'O-BOX-1'").get().total).toBe(260);
  });

  it('does not send the same write twice', async () => {
    await d1Run(box, 'INSERT INTO orders (id, items, total) VALUES (?, ?, ?)', ['O-BOX-2', '[]', 100]);

    await engine.runOnce();
    const second = await engine.runOnce();

    expect(second.pushed).toBe(0);
    expect(cloudDb.prepare('SELECT count(*) AS n FROM orders').get().n).toBe(1);
  });
});

describe('a booking made online reaches the box', () => {
  it('pulls and applies a cloud-owned entity', async () => {
    // Reservations are cloud-owned: customers book there, and the box has to
    // learn about the table being spoken for.
    cloudWrote('reservations', 'insert',
      'INSERT INTO reservations (id, name, date, time, guests, status) VALUES (?, ?, ?, ?, ?, ?)',
      ['RES-1', 'Selam', '2026-08-19', '19:00', 4, 'confirmed'], 'RES-1');

    const result = await engine.runOnce();

    expect(result.applied).toBe(1);
    expect(boxDb.prepare("SELECT name FROM reservations WHERE id = 'RES-1'").get().name).toBe('Selam');
  });
});

describe('the floor wins about the floor', () => {
  it('refuses a table change coming down from the cloud', async () => {
    // The box is watching the actual room; the cloud is guessing. A cloud
    // write to a table is a conflict, not an instruction — and it is recorded
    // rather than dropped.
    boxDb.prepare("INSERT INTO tables (id, number, status) VALUES ('3', 3, 'occupied')").run();
    cloudWrote('tables', 'update', 'UPDATE tables SET status = ? WHERE id = ?', ['available', '3'], '3');

    const result = await engine.runOnce();

    expect(result.conflicts).toBe(1);
    expect(boxDb.prepare("SELECT status FROM tables WHERE id = '3'").get().status).toBe('occupied');

    const open = boxDb.prepare('SELECT * FROM sync_reconciliation').all();
    expect(open).toHaveLength(1);
    expect(open[0].entity).toBe('tables');
  });

  it('tells the box its own write was refused', async () => {
    // Found by the staging rehearsal, which reported "run 0, cloud reports 1":
    // conflicts raised by a push happen on the far side, and the daemon was
    // ignoring the count in the reply. A manager at a healthy box would see
    // nothing wrong while refused writes piled up where they could not look.
    await d1Run(box, 'UPDATE staff SET role = ? WHERE id = ?', ['manager', 'S-NOBODY']);

    const result = await engine.runOnce();

    expect(result.refused).toBe(1);
    expect(result.conflicts).toBe(1);

    // And the box can report what the other side is holding, without anybody
    // having to go and look.
    const state = await engine.status();
    expect(state.unresolved_remote).toBeGreaterThanOrEqual(0);
  });

  it('surfaces a menu price edited on the box during an outage', async () => {
    // The manager may use the backoffice on the box. Menu is cloud-owned, so
    // the edit cannot simply be applied — it has to be seen.
    await d1Run(box, 'UPDATE menu_items SET price = ? WHERE id = ?', [120, 'M-1']);

    await engine.runOnce();

    const open = cloudDb.prepare('SELECT * FROM sync_reconciliation').all();
    expect(open).toHaveLength(1);
    expect(open[0].entity).toBe('menu_items');
    expect(open[0].site_id).toBe('local');
  });
});

describe('a box rebuilt from backup is not mistaken for the old one', () => {
  it('does not let the cloud skip a fresh journal', async () => {
    // The worst bug the staging rehearsal found, and it was completely silent:
    // a re-imaged box restarts seq at 1, the cloud compares those against the
    // cursor it remembers, and skips every entry as already applied. A full
    // day's trading into a void, with no error and no conflict.
    await d1Run(box, 'INSERT INTO orders (id, items, total) VALUES (?, ?, ?)', ['O-FIRST', '[]', 10]);
    await d1Run(box, 'INSERT INTO orders (id, items, total) VALUES (?, ?, ?)', ['O-SECOND', '[]', 20]);
    await engine.runOnce();
    expect(cloudDb.prepare('SELECT count(*) AS n FROM orders').get().n).toBe(2);

    // The box is rebuilt: same site_id, brand new journal starting at seq 1.
    boxDb.exec('DELETE FROM sync_outbox');
    boxDb.exec('DELETE FROM sync_cursors');
    boxDb.exec('DELETE FROM sync_identity');
    boxDb.exec("DELETE FROM sqlite_sequence WHERE name = 'sync_outbox'");

    await d1Run(box, 'INSERT INTO orders (id, items, total) VALUES (?, ?, ?)', ['O-AFTER-REBUILD', '[]', 30]);
    const result = await engine.runOnce();

    expect(result.pushed).toBeGreaterThan(0);
    expect(cloudDb.prepare("SELECT count(*) AS n FROM orders WHERE id = 'O-AFTER-REBUILD'").get().n).toBe(1);
  });

  it('still refuses to double-apply within one journal', async () => {
    // The epoch reset must not cost the idempotency it sits next to.
    await d1Run(box, 'INSERT INTO orders (id, items, total) VALUES (?, ?, ?)', ['O-ONCE', '[]', 40]);
    await engine.runOnce();
    const second = await engine.runOnce();

    expect(second.pushed).toBe(0);
    expect(cloudDb.prepare('SELECT count(*) AS n FROM orders').get().n).toBe(1);
  });
});

describe('the two sides do not talk in circles', () => {
  it('does not journal what it applied', async () => {
    // The failure this guards against is unbounded: each side journals the
    // other's replay, pushes it back, and the pair never go quiet again.
    cloudWrote('reservations', 'insert', 'INSERT INTO reservations (id, name) VALUES (?, ?)', ['RES-2', 'Abel'], 'RES-2');

    await engine.runOnce();
    const boxJournal = boxDb.prepare('SELECT count(*) AS n FROM sync_outbox').get().n;

    await engine.runOnce();
    await engine.runOnce();

    expect(boxDb.prepare('SELECT count(*) AS n FROM sync_outbox').get().n).toBe(boxJournal);
    expect(boxDb.prepare('SELECT count(*) AS n FROM reservations').get().n).toBe(1);
  });
});

describe('an outage', () => {
  it('is survived quietly', async () => {
    await d1Run(box, 'INSERT INTO orders (id, items, total) VALUES (?, ?, ?)', ['O-OFF-1', '[]', 50]);

    const offline = createSyncEngine({
      env: box,
      fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); },
    });

    // No throw: this runs on a timer on a box nobody is watching, and an
    // exception escaping would end the loop for good.
    await expect(offline.runOnce()).resolves.toEqual({ online: false });
    // And the write is still waiting, not lost.
    expect(boxDb.prepare('SELECT count(*) AS n FROM sync_outbox').get().n).toBe(1);
  });

  it('says so once rather than every thirty seconds', async () => {
    const offline = createSyncEngine({
      env: box,
      fetchImpl: async () => { throw new Error('unreachable'); },
    });

    await offline.runOnce();
    await offline.runOnce();
    await offline.runOnce();

    // A box offline for two days would otherwise write thousands of identical
    // lines to the disk it cannot afford to fill.
    const unreachable = logs.mock.calls.filter((c) => String(c[0]).includes('unreachable'));
    expect(unreachable).toHaveLength(1);
  });

  it('sends everything that queued up once the line returns', async () => {
    for (const id of ['O-Q1', 'O-Q2', 'O-Q3']) {
      await d1Run(box, 'INSERT INTO orders (id, items, total) VALUES (?, ?, ?)', [id, '[]', 10]);
    }

    const result = await engine.runOnce();

    expect(result.pushed).toBe(3);
    expect(cloudDb.prepare('SELECT count(*) AS n FROM orders').get().n).toBe(3);
  });
});

describe('the daemon stays off until it is configured', () => {
  it('does nothing without CLOUD_URL', async () => {
    const bare = createSyncEngine({ env: { ...box, CLOUD_URL: undefined }, fetchImpl: wireToCloud() });
    expect(bare.isConfigured()).toBe(false);
    await expect(bare.runOnce()).resolves.toEqual({ skipped: 'not configured' });
  });
});

describe('the journal does not grow forever', () => {
  it('prunes only what the cloud has acknowledged, and only once it is old', async () => {
    await d1Run(box, 'INSERT INTO orders (id, items, total) VALUES (?, ?, ?)', ['O-OLD', '[]', 10]);
    await engine.runOnce();

    // Nothing is old enough yet: a problem noticed on Monday must still be
    // traceable back through the weekend.
    expect(boxDb.prepare('SELECT count(*) AS n FROM sync_outbox').get().n).toBe(1);

    // Two weeks later.
    const later = createSyncEngine({
      env: box,
      fetchImpl: wireToCloud(),
      now: () => Date.now() + 14 * 24 * 60 * 60 * 1000,
    });
    const result = await later.runOnce();

    expect(result.pruned).toBe(1);
    expect(boxDb.prepare('SELECT count(*) AS n FROM sync_outbox').get().n).toBe(0);
  });

  it('never prunes what has not been acknowledged', async () => {
    await d1Run(box, 'INSERT INTO orders (id, items, total) VALUES (?, ?, ?)', ['O-UNSENT', '[]', 10]);

    // Old, but never pushed — the cursor is still at zero.
    const later = createSyncEngine({
      env: box,
      fetchImpl: async () => { throw new Error('offline'); },
      now: () => Date.now() + 365 * 24 * 60 * 60 * 1000,
    });
    await later.runOnce();

    expect(boxDb.prepare('SELECT count(*) AS n FROM sync_outbox').get().n).toBe(1);
  });
});
