/**
 * GET /api/health — the monitoring endpoint the architecture note calls for,
 * and the one thing that stays answerable while D1 is the thing that is down.
 *
 * It reads the quota circuit breaker (lib/quota.js): memory + KV, never D1.
 * During the 2026-09-04 outage the only public signals were a raw "error
 * code: 1101" and a Cloudflare dashboard — this endpoint exists so the next
 * degradation is a number anyone can curl: mode, rows read today, budget,
 * percentage, reset time.
 *
 * Anonymous callers (uptime monitors, the manager's phone, the website) get
 * the basic block: no business data, just a mode name and counters. A manager
 * presenting a session token additionally gets the operational detail —
 * per-isolate SSE client counts, cache hit/miss ratios, flush state — because
 * the session lookup happens HERE rather than in the auth gate (the route is
 * PUBLIC so it can never be blocked by the very outage it exists to report;
 * when D1 is dead the session lookup fails quietly and the basic block still
 * answers).
 *
 * POST /api/health/mode { mode } pins the circuit breaker by hand — the
 * manager's "stop the world" lever for when a report or a migration is about
 * to be run, or when the meter itself is distrusted. It is NOT public: the
 * role matrix resolves it as the `health` resource, which only the manager's
 * wildcard holds, so every other role is refused before this handler runs.
 */

import { json } from '../lib/db.js';
import { quotaSnapshot, setModeOverride, MODES } from '../lib/quota.js';
import { getAuthUser } from './session.js';
import { isManager } from '../auth.js';

export async function handleHealth(request, env) {
  let snap = null;
  try {
    snap = await quotaSnapshot(env);
  } catch {
    // Even the breaker failing must not take health down with it.
  }

  if (!snap) {
    return json({ ok: true, service: 'fufut-api', mode: 'unknown' });
  }

  const body = {
    ok: true,
    service: 'fufut-api',
    day: snap.day,
    mode: snap.mode,
    rows_read: snap.rowsRead,
    budget: snap.budget,
    pct: snap.pct,
    resets_at_utc: '00:00',
    thresholds: snap.thresholds,
  };

  // Optional manager detail. When D1 is down (exactly when detail matters
  // least and liveness matters most) this fails quietly — see module comment.
  try {
    const auth = await getAuthUser(request, env);
    if (auth && isManager(auth.sessionRole || auth.role)) {
      body.detail = snap.detail;
      body.override = snap.override;
      body.kv_ok = snap.kvOk;
    }
  } catch {
    // Anonymous-shaped answer, still a 200.
  }

  return json(body);
}

export async function handleHealthMode(request, env) {
  let body = null;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'JSON body required: { "mode": "conserve" }' }, 400);
  }
  const mode = String((body && body.mode) || '').trim().toLowerCase();
  if (mode !== 'auto' && !MODES.includes(mode)) {
    return json(
      { ok: false, error: `mode must be one of: auto, ${MODES.join(', ')}` },
      400
    );
  }
  try {
    const applied = await setModeOverride(env, mode);
    return json({ ok: true, mode: applied, override: true });
  } catch (e) {
    return json({ ok: false, error: 'Could not persist override: ' + String((e && e.message) || e) }, 500);
  }
}
