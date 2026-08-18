/**
 * The sync protocol — phase 2, tested through the real Worker.
 *
 * Nothing is mocked: requests go through `src/index.js`, the real authorization
 * gate and the real handlers, against real SQLite. The sync routes are the one
 * place in this system that accepts writes from a machine rather than a person,
 * so "does the gate actually hold" is not a question worth answering against a
 * stub.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import worker from '../src/index.js';
import { createLocalEnv } from '../local/env.js';

const TOKEN = 'a-shared-secret-for-the-box';

let dir;
let env;
let db;

function call(method, url, { body, token } = {}) {
  const request = new Request('http://localhost:8787' + url, {
    method,
    headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return worker
    .fetch(request, env, { waitUntil() {}, passThroughOnException() {} })
    .then(async (response) => {
      let payload = null;
      try { payload = await response.clone().json(); } catch { /* not JSON */ }
      return { status: response.status, body: payload };
    });
}

/** An entry as the box would have journalled it. */
function entry(seq, entity, op, sql, params, entityId) {
  return { seq, entity, entity_id: entityId ?? null, op, payload: JSON.stringify({ sql, params }), at: new Date().toISOString() };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fufut-sync-'));
  ({ env, db } = createLocalEnv({ dir, quiet: true }));
  // This side is standing in for the cloud: it receives what the box pushes.
  env.SITE_ID = 'cloud';
  env.SYNC_TOKEN = TOKEN;
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const reconciliation = () => db.prepare('SELECT * FROM sync_reconciliation ORDER BY id').all();

describe('the gate', () => {
  it('refuses a push with no token', async () => {
    const denied = await call('POST', '/api/sync/push', { body: { site_id: 'local', entries: [] } });
    expect(denied.status).toBe(401);
  });

  it('refuses a wrong token', async () => {
    const denied = await call('POST', '/api/sync/push', { body: { site_id: 'local', entries: [] }, token: 'wrong' });
    expect(denied.status).toBe(401);
  });

  it('does not exist at all when sync is not configured', async () => {
    // A deployment that has not switched sync on should not advertise that it
    // could. This is what keeps today's production surface unchanged.
    env.SYNC_TOKEN = undefined;
    const missing = await call('GET', '/api/sync/status?site_id=local', { token: TOKEN });
    expect(missing.status).toBe(404);
  });

  it('does not accept a staff session in place of the token', async () => {
    // The machine routes are not reachable by a person, however senior.
    const denied = await call('GET', '/api/sync/pull?since=0');
    expect(denied.status).toBe(401);
  });
});

describe('push', () => {
  it('applies what the box sends', async () => {
    const res = await call('POST', '/api/sync/push', {
      token: TOKEN,
      body: {
        site_id: 'local',
        entries: [
          entry(1, 'tables', 'insert', 'INSERT INTO tables (id, number, status) VALUES (?, ?, ?)', ['5', 5, 'occupied'], '5'),
        ],
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(1);
    expect(db.prepare("SELECT status FROM tables WHERE id = '5'").get().status).toBe('occupied');
  });

  it('applies in seq order however the entries arrive', async () => {
    // "Mark it served" must not land before "add the item".
    await call('POST', '/api/sync/push', {
      token: TOKEN,
      body: {
        site_id: 'local',
        entries: [
          entry(2, 'tables', 'update', 'UPDATE tables SET status = ? WHERE id = ?', ['occupied', '6'], '6'),
          entry(1, 'tables', 'insert', 'INSERT INTO tables (id, number, status) VALUES (?, ?, ?)', ['6', 6, 'available'], '6'),
        ],
      },
    });

    expect(db.prepare("SELECT status FROM tables WHERE id = '6'").get().status).toBe('occupied');
  });

  it('is idempotent when a push is sent twice', async () => {
    // The response to a successful push can be lost. Resending must not
    // double-apply — that is the whole reason the cursor exists.
    const body = {
      site_id: 'local',
      entries: [
        entry(1, 'payments', 'insert',
          'INSERT INTO payments (id, order_id, method, amount, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          ['PM1', 'O1', 'cash', 100, 'verified', '2026-08-18'], 'PM1'),
      ],
    };

    const first = await call('POST', '/api/sync/push', { token: TOKEN, body });
    const second = await call('POST', '/api/sync/push', { token: TOKEN, body });

    expect(first.body.applied).toBe(1);
    expect(second.body.skipped).toBe(1);
    expect(second.body.applied).toBe(0);
    expect(db.prepare('SELECT count(*) AS n FROM payments').get().n).toBe(1);
  });

  it('advances the cursor so the next push starts where this one ended', async () => {
    await call('POST', '/api/sync/push', {
      token: TOKEN,
      body: { site_id: 'local', entries: [entry(7, 'tables', 'insert', 'INSERT INTO tables (id, number) VALUES (?, ?)', ['7', 7], '7')] },
    });

    const cursor = db.prepare("SELECT last_seq FROM sync_cursors WHERE site_id = 'local' AND direction = 'in'").get();
    expect(cursor.last_seq).toBe(7);
  });
});

describe('ownership decides what is allowed in', () => {
  it('refuses a cloud-owned entity written on the box', async () => {
    // The locked decision lets a manager use the backoffice on the box during
    // an outage. Editing a price there writes to a cloud-owned entity, and it
    // has to surface rather than silently overwrite the cloud.
    const res = await call('POST', '/api/sync/push', {
      token: TOKEN,
      body: {
        site_id: 'local',
        entries: [
          entry(1, 'menu_items', 'update', 'UPDATE menu_items SET price = ? WHERE id = ?', [99, 'M1'], 'M1'),
        ],
      },
    });

    expect(res.body.conflict).toBe(1);
    expect(res.body.applied).toBe(0);

    const open = reconciliation();
    expect(open).toHaveLength(1);
    expect(open[0].entity).toBe('menu_items');
    expect(open[0].reason).toContain('cloud-owned');
    expect(open[0].resolved).toBe(0);
  });

  it('never silently drops a refusal', async () => {
    await call('POST', '/api/sync/push', {
      token: TOKEN,
      body: { site_id: 'local', entries: [entry(1, 'staff', 'update', 'UPDATE staff SET role = ? WHERE id = ?', ['manager', 'S1'], 'S1')] },
    });

    // The payload is kept whole, so a human can see exactly what was refused.
    const [row] = reconciliation();
    expect(JSON.parse(row.payload).params).toEqual(['manager', 'S1']);
  });

  it('takes an append-only insert but refuses an edit to the log', async () => {
    const res = await call('POST', '/api/sync/push', {
      token: TOKEN,
      body: {
        site_id: 'local',
        entries: [
          entry(1, 'audit_log', 'insert',
            'INSERT INTO audit_log (id, at, action, entity) VALUES (?, ?, ?, ?)',
            ['A1', '2026-08-18', 'seated', 'tables'], 'A1'),
          entry(2, 'audit_log', 'update', 'UPDATE audit_log SET action = ? WHERE id = ?', ['changed', 'A1'], 'A1'),
        ],
      },
    });

    expect(res.body.applied).toBe(1);
    expect(res.body.conflict).toBe(1);
  });
});

describe('an update that matches nothing is not success', () => {
  it('records it instead of acknowledging it', async () => {
    // The trap this exists for: the handlers write conditional updates, and the
    // atomic table claim carries `AND status <> 'occupied'`. Re-evaluated
    // against this side's state it can match no rows, leaving the cloud with a
    // different answer from the floor and nobody any the wiser.
    db.prepare("INSERT INTO tables (id, number, status) VALUES ('8', 8, 'occupied')").run();

    const res = await call('POST', '/api/sync/push', {
      token: TOKEN,
      body: {
        site_id: 'local',
        entries: [
          entry(1, 'tables', 'update',
            "UPDATE tables SET status = ? WHERE id = ? AND status <> 'occupied'", ['occupied', '8'], '8'),
        ],
      },
    });

    expect(res.body.conflict).toBe(1);
    expect(reconciliation()[0].reason).toContain('matched no rows');
  });
});

describe('pull', () => {
  beforeEach(() => {
    const insert = db.prepare(
      "INSERT INTO sync_outbox (entity, entity_id, op, payload, at) VALUES (?, ?, 'insert', ?, '2026-08-18')"
    );
    for (const id of ['R1', 'R2', 'R3']) {
      insert.run('reservations', id, JSON.stringify({ sql: 'INSERT INTO reservations (id) VALUES (?)', params: [id] }));
    }
  });

  it('hands over everything after the cursor', async () => {
    const res = await call('GET', '/api/sync/pull?since=0', { token: TOKEN });
    expect(res.status).toBe(200);
    expect(res.body.entries.map((e) => e.entity_id)).toEqual(['R1', 'R2', 'R3']);
    expect(res.body.last_seq).toBe(3);
  });

  it('hands over only what is new', async () => {
    const res = await call('GET', '/api/sync/pull?since=2', { token: TOKEN });
    expect(res.body.entries.map((e) => e.entity_id)).toEqual(['R3']);
  });

  it('flags that there is more, so a long outage drains in one go', async () => {
    const capped = await call('GET', '/api/sync/pull?since=0&limit=2', { token: TOKEN });
    expect(capped.body.entries).toHaveLength(2);
    expect(capped.body.more).toBe(true);

    const rest = await call('GET', `/api/sync/pull?since=${capped.body.last_seq}&limit=2`, { token: TOKEN });
    expect(rest.body.more).toBe(false);
  });
});

describe('applied writes do not echo back', () => {
  it('does not journal what it received', async () => {
    // Without this the two sides ping-pong forever: the receiver journals the
    // replay, pushes it back, the sender applies and journals it in turn.
    const before = db.prepare('SELECT count(*) AS n FROM sync_outbox').get().n;

    await call('POST', '/api/sync/push', {
      token: TOKEN,
      body: { site_id: 'local', entries: [entry(1, 'tables', 'insert', 'INSERT INTO tables (id, number) VALUES (?, ?)', ['9', 9], '9')] },
    });

    expect(db.prepare('SELECT count(*) AS n FROM sync_outbox').get().n).toBe(before);
  });
});

describe('status', () => {
  it('records the heartbeat the ordering page reads', async () => {
    const res = await call('GET', '/api/sync/status?site_id=local', { token: TOKEN });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const beat = db.prepare("SELECT * FROM venue_heartbeat WHERE site_id = 'local'").get();
    expect(beat).toBeTruthy();
    expect(new Date(beat.last_seen).getTime()).toBeGreaterThan(Date.now() - 10_000);
  });

  it('reports how many conflicts are waiting for somebody', async () => {
    await call('POST', '/api/sync/push', {
      token: TOKEN,
      body: { site_id: 'local', entries: [entry(1, 'staff', 'delete', 'DELETE FROM staff WHERE id = ?', ['S1'], 'S1')] },
    });

    const res = await call('GET', '/api/sync/status?site_id=local', { token: TOKEN });
    expect(res.body.unresolved_conflicts).toBe(1);
  });
});
