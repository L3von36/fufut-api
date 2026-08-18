/**
 * Online ordering while the venue is offline — phase 4.
 *
 * The locked decision: an order the kitchen will never see is worse than an
 * order not taken. The customer who is told ordering is briefly closed can call
 * or go elsewhere; the one who pays and waits for food nobody started has a
 * complaint and a refund.
 *
 * The website reading a flag is a courtesy — a cached page, a stale tab or a
 * direct POST would sail straight past it. The guarantee has to be the API
 * refusing, so that is what is tested here.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import worker from '../src/index.js';
import { createLocalEnv } from '../local/env.js';
import { hashPassword } from '../src/lib/crypto.js';
import { venueStatus, OFFLINE_AFTER_MS } from '../src/lib/venue.js';

let dir;
let env;
let db;

const ORDER = { type: 'delivery', items: [{ name: 'Buna', qty: 1, price: 60 }], total: 60 };

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
    .then(async (response) => {
      let payload = null;
      try { payload = await response.clone().json(); } catch { /* not JSON */ }
      return { status: response.status, body: payload };
    });
}

/** The box last said hello this many milliseconds ago. */
function heartbeat(agoMs) {
  db.prepare('INSERT OR REPLACE INTO venue_heartbeat (site_id, last_seen) VALUES (?, ?)')
    .run('local', new Date(Date.now() - agoMs).toISOString());
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fufut-venue-'));
  ({ env, db } = createLocalEnv({ dir, quiet: true }));
  env.SITE_ID = 'cloud';
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('a deployment with no box at all', () => {
  it('treats ordering as open', async () => {
    // This is today's production. Closing the shop because a machine that does
    // not exist has not said hello would take the website down the moment this
    // code deployed.
    const status = await venueStatus(env);
    expect(status.known).toBe(false);
    expect(status.online).toBe(true);
  });

  it('still accepts an anonymous order', async () => {
    const res = await call('POST', '/api/orders', { body: ORDER });
    expect(res.status).toBeLessThan(300);
    expect(res.body.ok).toBe(true);
  });
});

describe('a box that is checking in', () => {
  it('leaves ordering open', async () => {
    heartbeat(5_000);
    const res = await call('POST', '/api/orders', { body: ORDER });
    expect(res.status).toBeLessThan(300);
  });

  it('does not shut the shop over one missed beat', async () => {
    // A single slow poll or a garbage-collection pause is not an outage.
    heartbeat(35_000);
    const res = await call('POST', '/api/orders', { body: ORDER });
    expect(res.status).toBeLessThan(300);
  });
});

describe('a box that has gone quiet', () => {
  beforeEach(() => heartbeat(OFFLINE_AFTER_MS + 30_000));

  it('refuses an anonymous order', async () => {
    const res = await call('POST', '/api/orders', { body: ORDER });

    expect(res.status).toBe(503);
    expect(res.body.reason).toBe('venue-offline');
    // Something a customer can act on, not a stack trace.
    expect(res.body.error).toMatch(/closed|shortly/i);
  });

  it('writes no order at all', async () => {
    await call('POST', '/api/orders', { body: ORDER });
    expect(db.prepare('SELECT count(*) AS n FROM orders').get().n).toBe(0);
  });

  it('still lets signed-in staff take an order', async () => {
    // The box being down while the line is up is exactly when the tablets fall
    // back to the cloud. Closing that would take the till offline at the worst
    // possible moment — the opposite of the point.
    db.prepare(
      `INSERT INTO staff (id, firstName, lastName, email, role, status, password_hash, must_change_password, created)
       VALUES ('S1','A','B','waiter@local.test','head-waiter','active',?,0,?)`
    ).run(await hashPassword('waiterpass1'), new Date().toISOString());

    const login = await call('POST', '/api/auth/login', {
      body: { email: 'waiter@local.test', password: 'waiterpass1' },
    });
    expect(login.status).toBe(200);
    const cookie = db.prepare('SELECT token FROM sessions LIMIT 1').get().token;

    const res = await call('POST', '/api/orders', { body: { ...ORDER, type: 'dine-in' }, cookie: `session=${cookie}` });
    expect(res.status).toBeLessThan(300);
  });
});

describe('the website is told before the customer starts', () => {
  it('reports ordering open with no box', async () => {
    const res = await call('GET', '/api/venue/status');
    expect(res.status).toBe(200);
    expect(res.body.online_ordering).toBe(true);
  });

  it('reports ordering closed when the venue is quiet', async () => {
    heartbeat(OFFLINE_AFTER_MS + 60_000);
    const res = await call('GET', '/api/venue/status');
    expect(res.body.online_ordering).toBe(false);
    expect(res.body.last_seen).toBeTruthy();
  });

  it('needs no session, because the customer has none', async () => {
    const res = await call('GET', '/api/venue/status');
    expect(res.status).toBe(200);
  });
});

describe('the check never becomes the thing that breaks ordering', () => {
  it('opens ordering when the heartbeat cannot be read at all', async () => {
    // If this cannot tell, it must say the venue is up: that is how the system
    // behaved before any of this existed.
    db.exec('DROP TABLE venue_heartbeat');
    const status = await venueStatus(env);
    expect(status.online).toBe(true);

    const res = await call('POST', '/api/orders', { body: ORDER });
    expect(res.status).toBeLessThan(300);
  });

  it('opens ordering when the timestamp is nonsense', async () => {
    db.prepare("INSERT INTO venue_heartbeat (site_id, last_seen) VALUES ('local', 'not a date')").run();
    expect((await venueStatus(env)).online).toBe(true);
  });
});
