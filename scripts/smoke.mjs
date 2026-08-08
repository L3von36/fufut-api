#!/usr/bin/env node
/**
 * Post-deploy smoke test — run against the real deployed URL.
 *
 * This exists because of a specific incident: an earlier rewrite of this Worker
 * silently dropped every auth check. `getAuthUser` stayed in the source as dead
 * code, unit tests still passed, and the API served staff phone numbers and
 * customer PII to the open internet until someone happened to curl it.
 *
 * Unit tests cannot catch that — the policy module was fine, it just was not
 * wired in. Only asserting against a live deployment catches it. This runs in
 * CI after every deploy and fails the build if the API is open.
 *
 * Usage: node scripts/smoke.mjs https://fufut-api.fufutcoffee.workers.dev
 */

const BASE = process.argv[2] || 'https://fufut-api.fufutcoffee.workers.dev';

// Cache-bust: Cloudflare's edge served pre-deploy 200s for a short window after
// cutover, which briefly looked like the auth gate had failed.
const bust = () => `cb=${Date.now()}-${Math.random().toString(36).slice(2)}`;

let failures = 0;
const results = [];

async function check(name, expected, path, init = {}) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${BASE}${path}${sep}${bust()}`;
  let status;
  try {
    const res = await fetch(url, {
      ...init,
      headers: { 'Cache-Control': 'no-cache', ...(init.headers || {}) },
    });
    status = res.status;
  } catch (e) {
    status = `ERR ${e.message}`;
  }
  const ok = Array.isArray(expected) ? expected.includes(status) : status === expected;
  if (!ok) failures++;
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name} -> ${status} (expected ${expected})`);
}

// ── The public website is served by this same Worker. If any of these break,
//    fufutcoffee.com stops rendering its menu or taking bookings.
await check('public: content', 200, '/api/content');
await check('public: menus', 200, '/api/menus');
await check('public: menu', 200, '/api/menu');
await check('public: reviews', 200, '/api/reviews');

// Anonymous customer actions. 400 = reached validation, i.e. auth let it
// through. 401 here would mean online booking and ordering are broken.
const badJson = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'bad{{' };
await check('public: create reservation', 400, '/api/reservations', badJson);
await check('public: create order', 400, '/api/orders', badJson);
await check('public: create review', 400, '/api/reviews', badJson);

// ── Everything below answered 200 unauthenticated before the fix.
for (const r of ['staff', 'orders', 'reservations', 'expenses', 'inventory',
                 'tables', 'shifts', 'timeclock', 'waste', 'delivery']) {
  await check(`protected: GET ${r}`, 401, `/api/${r}`);
}
await check('protected: SSE tables', 401, '/api/events/tables');
await check('protected: SSE kitchen', 401, '/api/events/kitchen');

// Writes reached the database unauthenticated before the fix.
await check('protected: PUT staff', 401, '/api/staff/NX', { method: 'PUT', ...badJson });
await check('protected: DELETE staff', 401, '/api/staff/NX', { method: 'DELETE' });
await check('protected: POST migrate', 401, '/api/migrate/kv-to-d1', { method: 'POST' });

// Credentials must still be verified.
await check('login rejects bad password', 401, '/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'asnegash@fufut.coffee', password: 'definitely-wrong' }),
});

console.log(results.join('\n'));
console.log(`\n${results.length - failures}/${results.length} passed against ${BASE}`);
process.exit(failures ? 1 : 0);
