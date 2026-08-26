/**
 * The whole Worker, running on the local box.
 *
 * This is the test the local-server plan turns on. Every other test in this
 * suite mocks `env.DB`, so none of them can tell you whether the real handlers
 * survive contact with real SQLite. Here nothing is mocked: the actual
 * `src/index.js` entry point, the actual routing and auth, the actual SQL,
 * against a real database created from the production schema.
 *
 * If the adapter is wrong, this is where it shows.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import worker from '../src/index.js';
import { createLocalEnv } from '../local/env.js';
import { hashPassword } from '../src/lib/crypto.js';

const MANAGER = { id: 'S-TEST-1', email: 'manager@local.test', password: 'localbox123' };

let dir;
let env;
let db;
let cookie = '';

/** Call the Worker exactly as Cloudflare would. */
async function call(method, url, body) {
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
  try { payload = await response.clone().json(); } catch { /* not every response is JSON */ }
  return { status: response.status, body: payload, response };
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fufut-runtime-'));
  ({ env, db } = createLocalEnv({ dir, quiet: true }));

  db.prepare(
    `INSERT INTO staff (id, firstName, lastName, email, role, status, password_hash, must_change_password, created)
     VALUES (?, ?, ?, ?, ?, 'active', ?, 0, ?)`
  ).run(MANAGER.id, 'Local', 'Manager', MANAGER.email, 'manager', await hashPassword(MANAGER.password), new Date().toISOString());

  db.prepare(
    "INSERT INTO tables (id, number, name, capacity, section, status, guests) VALUES ('9', 9, 'T9', 4, 'main', 'available', 0)"
  ).run();
  db.prepare(
    "INSERT INTO tables (id, number, name, capacity, section, status, guests) VALUES ('8', 8, 'T8', 2, 'window', 'available', 0)"
  ).run();
});

afterAll(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the production schema loads', () => {
  it('creates every table the Worker expects', () => {
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name);

    for (const table of ['orders', 'order_items', 'staff', 'tables', 'sessions', 'payments', 'audit_log']) {
      expect(names).toContain(table);
    }
  });
});

describe('signing in', () => {
  it('rejects the wrong password', async () => {
    const bad = await call('POST', '/api/auth/login', { email: MANAGER.email, password: 'not-the-password' });
    expect(bad.status).toBe(401);
  });

  it('accepts the right one and issues a session', async () => {
    const ok = await call('POST', '/api/auth/login', { email: MANAGER.email, password: MANAGER.password });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);

    const setCookie = ok.response.headers.get('set-cookie');
    expect(setCookie).toBeTruthy();
    cookie = setCookie.split(';')[0];

    // The session was written to SQLite through the adapter, not held in memory.
    const sessions = db.prepare('SELECT count(*) AS n FROM sessions').get();
    expect(sessions.n).toBe(1);
  });

  it('recognises the session on the next request', async () => {
    const me = await call('GET', '/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.role).toBe('manager');
  });

  it('still refuses an unauthenticated request', async () => {
    const saved = cookie;
    cookie = '';
    const denied = await call('GET', '/api/staff');
    cookie = saved;
    expect(denied.status).toBe(401);
  });
});

describe('taking an order', () => {
  let orderId;

  it('writes the order and its lines', async () => {
    const created = await call('POST', '/api/orders', {
      type: 'dine-in',
      tableNum: '9',
      status: 'new',
      total: 260,
      items: [
        { name: 'Macchiato', qty: 2, price: 60 },
        { name: 'Fut Breakfast Gebeta', qty: 1, price: 140 },
      ],
    });

    expect(created.status).toBeLessThan(300);
    orderId = created.body.id || (created.body.order && created.body.order.id);
    expect(orderId).toBeTruthy();

    // insertOrderItems swallows a batch failure into a warning rather than
    // failing the order, so a green status alone would prove nothing about the
    // batch path.
    expect(created.body.warning ?? null).toBeNull();
  });

  it('committed the batched line items', async () => {
    const lines = db.prepare('SELECT name, qty FROM order_items WHERE order_id = ? ORDER BY line_no').all(orderId);
    expect(lines.map((l) => l.name)).toEqual(['Macchiato', 'Fut Breakfast Gebeta']);
    expect(lines[0].qty).toBe(2);
  });

  it('reads the order back through the API', async () => {
    const fetched = await call('GET', '/api/orders/' + orderId);
    expect(fetched.status).toBe(200);
    expect(Number(fetched.body.total)).toBe(260);
  });

  it('auto-seated the dine-in table (Finding 1)', async () => {
    // POST /api/orders now seats the table when type='dine-in', so T9 must
    // be occupied at this point without any separate PUT.
    const row = db.prepare("SELECT status, seated_at FROM tables WHERE id = '9'").get();
    expect(row.status).toBe('occupied');
    expect(row.seated_at).toBeTruthy();
  });
});

describe('seating a table', () => {
  it('claims a free table and refuses the second claim', async () => {
    // T9 is now auto-seated when a dine-in order is created on it (Finding 1
    // from the B+ simulation), so this uses T8 — which the order test above
    // never touches — to exercise the manual seating path.
    const first = await call('PUT', '/api/tables/8', {
      id: '8', number: 8, status: 'occupied', guests: 2, server: 'Local Manager',
    });
    expect(first.status).toBe(200);

    // The atomic claim relies on meta.changes coming back from the adapter. If
    // that were wrong this would wrongly succeed, and two waiters would seat
    // two parties at one table.
    const second = await call('PUT', '/api/tables/8', {
      id: '8', number: 8, status: 'occupied', guests: 4, server: 'Someone Else',
    });
    expect(second.status).toBe(409);
  });
});

describe('KV and R2 stand in for the real bindings', () => {
  it('round-trips a value through KV', async () => {
    await env.CONTENT_KV.put('probe', JSON.stringify({ hello: 'world' }));
    expect(JSON.parse(await env.CONTENT_KV.get('probe'))).toEqual({ hello: 'world' });
    expect(await env.CONTENT_KV.get('probe', 'json')).toEqual({ hello: 'world' });

    await env.CONTENT_KV.delete('probe');
    expect(await env.CONTENT_KV.get('probe')).toBeNull();
  });

  it('keeps namespaces apart', async () => {
    await env.MENU_KV.put('data', 'menu');
    await env.ORDERS_KV.put('data', 'orders');
    expect(await env.MENU_KV.get('data')).toBe('menu');
    expect(await env.ORDERS_KV.get('data')).toBe('orders');
  });

  it('stores and serves an image', async () => {
    await env.IMAGES_R2.put('menu/test.png', Buffer.from('not really a png'), {
      httpMetadata: { contentType: 'image/png' },
    });

    const served = await call('GET', '/api/images/' + encodeURIComponent('menu/test.png'));
    expect(served.status).toBe(200);
    expect(served.response.headers.get('Content-Type')).toBe('image/png');
    expect(await served.response.text()).toBe('not really a png');
  });

  it('returns 404 for an object that is not there', async () => {
    const missing = await call('GET', '/api/images/' + encodeURIComponent('menu/absent.png'));
    expect(missing.status).toBe(404);
  });

  it('refuses a key that climbs out of the bucket', async () => {
    // The key arrives from a URL, so this is reachable by anyone.
    const escape = await call('GET', '/api/images/' + encodeURIComponent('../../../etc/passwd'));
    expect(escape.status).toBe(404);
  });
});

describe('live updates', () => {
  /**
   * The kitchen board and the table map subscribe to these. They are the only
   * streaming responses in the system, and they were the only thing that did
   * not survive the move off Cloudflare: sse.js carried `__name(...)`, an
   * esbuild helper that only exists once wrangler has bundled the code. In
   * production the bundler supplies it; running the source directly, the whole
   * endpoint threw ReferenceError.
   */
  it('streams events rather than throwing', async () => {
    const aborter = new AbortController();
    const request = new Request('http://localhost:8787/api/events/tables', {
      headers: { Cookie: cookie, Accept: 'text/event-stream' },
      signal: aborter.signal,
    });
    const response = await worker.fetch(request, env, { waitUntil() {}, passThroughOnException() {} });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');

    const reader = response.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('event: connected');

    aborter.abort();
    await reader.cancel().catch(() => {});
  });
});

describe('src/ is source, not bundler output', () => {
  /**
   * `__name` reaching a committed file is how SSE broke. It works on
   * Cloudflare, where esbuild injects the helper, and nowhere else — so the
   * local box was the first thing to notice. Guarding it here keeps the next
   * paste of bundler output from quietly costing us the same endpoint again.
   */
  it('carries no esbuild helpers', () => {
    const root = new URL('../src/', import.meta.url);
    const offenders = [];

    const walk = (dirUrl) => {
      for (const entry of fs.readdirSync(dirUrl, { withFileTypes: true })) {
        const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dirUrl);
        if (entry.isDirectory()) walk(child);
        else if (entry.name.endsWith('.js')) {
          const text = fs.readFileSync(child, 'utf8');
          if (/\b(__name|__toESM|__commonJS|__defProp)\b/.test(text)) {
            offenders.push(entry.name);
          }
        }
      }
    };
    walk(root);

    expect(offenders).toEqual([]);
  });
});

describe('the scheduled trigger runs', () => {
  it('completes without error', async () => {
    await expect(
      worker.scheduled({ cron: '* * * * *', scheduledTime: Date.now() }, env, { waitUntil() {}, passThroughOnException() {} })
    ).resolves.not.toThrow();
  });
});
