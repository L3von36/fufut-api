/**
 * Operations alerts — the sweep and the API in front of it.
 *
 * The cron runs every minute and already sweeps two pieces of unattended
 * state (scheduled content, overstayed tables). This module adds the third:
 * evaluate every SLA rule against live rows, raise what is new, escalate what
 * got worse, resolve what cleared. The result lands in `alerts`, and every
 * screen that cares reads it from there — the sweep never pushes, the screens
 * pull (or subscribe to /api/events/alerts, which reads the same table).
 *
 * One row per (rule, entity) while the condition holds. Acknowledged rows are
 * left alone: an ack is a person saying "I have this", and re-raising every
 * minute would train the floor to ignore the banner. When the condition
 * clears — the food was served, the driver assigned — the row resolves and a
 * future breach raises fresh.
 */

import { d1Query, d1Run, json, readBody, now, vid } from '../lib/db.js';
import { writeAudit } from '../lib/audit.js';
import { actorName } from '../auth.js';
import {
  evaluateAll,
  dedupeKey,
  RULE_DEFAULTS,
  RULE_IDS,
  SEVERITY,
} from '../lib/rules.js';

/**
 * Thresholds from the settings table, defaults behind every miss.
 *
 * The same pattern as loadStaleHours in handlers/orders.js: the manager owns
 * the numbers, the deploy does not. Keys are `alerts.*`; anything unreadable
 * or absent falls back to RULE_DEFAULTS.
 */
export async function loadAlertThresholds(env) {
  const th = { ...RULE_DEFAULTS, enabled: true };
  try {
    const { results } = await d1Query(env, "SELECT key, value FROM settings WHERE key LIKE 'alerts.%'");
    for (const r of results || []) {
      const key = String(r.key || '');
      if (key === 'alerts.enabled') {
        th.enabled = !/^(0|false|off|no)$/i.test(String(r.value).replace(/"/g, '').trim());
        continue;
      }
      const prop = key.replace(/^alerts\./, '');
      if (!(prop in RULE_DEFAULTS)) continue;
      const n = Number(String(r.value).replace(/"/g, ''));
      if (Number.isFinite(n) && n > 0) th[prop] = n;
    }
  } catch {
    // Before migration 007 there is no settings table; before 022 nobody set
    // an alerts.* key. Defaults are correct in both cases.
  }
  return th;
}

function num(v) {
  return Number(String(v ?? '').replace(/"/g, '').trim());
}

/** Rows the stage rules judge: anything not finished and not cancelled. */
async function loadSweepRows(env) {
  const [ordersStage, ordersUnpaid, deliveryJobs, reservations, tables] = await Promise.all([
    d1Query(
      env,
      "SELECT * FROM orders WHERE status IN ('new','confirmed','preparing','ready') ORDER BY created"
    ),
    d1Query(
      env,
      "SELECT * FROM orders WHERE status IN ('served','fulfilled') " +
      "AND (payment_status IS NULL OR payment_status IN ('unpaid','partial')) " +
      "AND COALESCE(voided_at, '') = '' ORDER BY created"
    ),
    d1Query(
      env,
      "SELECT * FROM delivery WHERE status IN ('ready','picked_up','out_for_delivery') ORDER BY created"
    ),
    d1Query(
      env,
      "SELECT * FROM reservations WHERE status IN ('new','confirmed') " +
      "AND COALESCE(released_at, '') = '' AND COALESCE(no_show_at, '') = '' ORDER BY start_at"
    ),
    d1Query(env, "SELECT * FROM tables WHERE status = 'occupied' ORDER BY seated_at"),
  ]);
  return {
    orders: [...(ordersStage.results || []), ...(ordersUnpaid.results || [])],
    deliveryJobs: deliveryJobs.results || [],
    reservations: reservations.results || [],
    tables: tables.results || [],
  };
}

/**
 * Run the rules and reconcile `alerts` with what they found.
 *
 * Raises, escalates and de-escalates in place, and resolves everything whose
 * condition cleared. Returns the counts so the cron log says what happened —
 * a sweep that silently did nothing and a sweep that silently failed look
 * identical otherwise.
 */
export async function runAlertSweep(env) {
  const th = await loadAlertThresholds(env);
  if (!th.enabled) return { skipped: true, raised: 0, changed: 0, resolved: 0 };

  const rows = await loadSweepRows(env);
  const violations = evaluateAll(rows, Date.now(), th);
  const wanted = new Map();
  for (const v of violations) wanted.set(dedupeKey(v), v);

  // Every row still telling its story, acked or not. An acked row suppresses
  // re-raising; a resolved row is forgotten here on purpose.
  const { results: live } = await d1Query(
    env,
    "SELECT id, rule_id, entity_type, entity_id, severity, status FROM alerts WHERE status IN ('open','acknowledged')"
  );
  const existing = new Map();
  for (const r of live || []) existing.set(`${r.rule_id}|${r.entity_type}|${r.entity_id}`, r);

  const stamp = now();
  let raised = 0;
  let changed = 0;
  let resolved = 0;

  for (const [key, v] of wanted) {
    const row = existing.get(key);
    if (!row) {
      await d1Run(
        env,
        `INSERT INTO alerts (id, rule_id, severity, entity_type, entity_id, entity_label, message, status, created, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
        [vid(), v.rule_id, v.severity, v.entity_type, v.entity_id, v.entity_label || '', v.message, stamp, stamp]
      );
      raised += 1;
      continue;
    }
    // Severity moves with the condition while the alert is open: a ticket
    // that crossed from warning into critical must say so, and one that was
    // re-timed back under must not keep shouting. Acked rows are the floor's
    // problem now, not the sweep's.
    if (row.status === 'open' && row.severity !== v.severity) {
      await d1Run(
        env,
        'UPDATE alerts SET severity = ?, message = ?, updated_at = ? WHERE id = ?',
        [v.severity, v.message, stamp, row.id]
      );
      changed += 1;
    }
  }

  for (const [key, row] of existing) {
    if (wanted.has(key)) continue;
    await d1Run(
      env,
      "UPDATE alerts SET status = 'resolved', resolved_at = ?, updated_at = ? WHERE id = ?",
      [stamp, stamp, row.id]
    );
    resolved += 1;
  }

  return { skipped: false, raised, changed, resolved, evaluated: violations.length };
}

function isManager(auth) {
  const role = auth && (auth.sessionRole || auth.role);
  return String(role || '').toLowerCase() === 'manager';
}

/** GET /api/alerts — open by default, ?status=… or ?all=1 to widen. */
async function listAlerts(url, env) {
  const wantsAll = ['1', 'true', 'yes'].includes(String(url.searchParams.get('all') || '').toLowerCase());
  const statusParam = String(url.searchParams.get('status') || 'open').toLowerCase().trim();
  const limitRaw = num(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 200;

  let rows;
  if (wantsAll) {
    ({ results: rows } = await d1Query(env, 'SELECT * FROM alerts ORDER BY created DESC LIMIT ?', [limit]));
  } else {
    const status = ['open', 'acknowledged', 'resolved'].includes(statusParam) ? statusParam : 'open';
    ({ results: rows } = await d1Query(env, 'SELECT * FROM alerts WHERE status = ? ORDER BY created DESC LIMIT ?', [status, limit]));
  }
  return json({ ok: true, alerts: rows || [] });
}

/** GET /api/alerts/summary — what a banner needs, in one cheap query. */
async function alertSummary(env) {
  const { results } = await d1Query(
    env,
    "SELECT severity, COUNT(*) AS n FROM alerts WHERE status = 'open' GROUP BY severity"
  );
  const bySeverity = { critical: 0, warning: 0 };
  for (const r of results || []) bySeverity[String(r.severity || '').toLowerCase()] = Number(r.n) || 0;
  const { results: byRuleRows } = await d1Query(
    env,
    "SELECT rule_id, COUNT(*) AS n FROM alerts WHERE status = 'open' GROUP BY rule_id"
  );
  const byRule = {};
  for (const r of byRuleRows || []) byRule[String(r.rule_id)] = Number(r.n) || 0;
  return json({
    ok: true,
    open: (bySeverity.critical || 0) + (bySeverity.warning || 0),
    critical: bySeverity.critical || 0,
    warning: bySeverity.warning || 0,
    byRule,
  });
}

/** POST /api/alerts/:id/acknowledge — one row, signed. */
async function acknowledgeOne(id, request, env, auth) {
  if (!id) return json({ ok: false, error: 'Alert id required' }, 400);
  const { results } = await d1Query(env, 'SELECT * FROM alerts WHERE id = ?', [String(id)]);
  const row = (results || [])[0];
  if (!row) return json({ ok: false, error: 'Alert not found' }, 404);
  if (row.status === 'resolved') return json({ ok: false, error: 'Alert already resolved' }, 409);

  const stamp = now();
  await d1Run(
    env,
    "UPDATE alerts SET status = 'acknowledged', acknowledged_at = ?, acknowledged_by = ?, updated_at = ? WHERE id = ?",
    [stamp, actorName(auth), stamp, row.id]
  );
  await writeAudit(env, auth, {
    action: 'update',
    entity: 'alerts',
    entityId: row.id,
    before: { status: row.status },
    after: { status: 'acknowledged', rule_id: row.rule_id },
  });
  return json({ ok: true, acknowledged: row.id });
}

/** POST /api/alerts/acknowledge-all — manager's "checked everything". */
async function acknowledgeAll(env, auth) {
  if (!isManager(auth)) return json({ ok: false, error: 'Manager only' }, 403);
  const stamp = now();
  const { results } = await d1Query(env, "SELECT id FROM alerts WHERE status = 'open'");
  const open = results || [];
  for (const r of open) {
    await d1Run(
      env,
      "UPDATE alerts SET status = 'acknowledged', acknowledged_at = ?, acknowledged_by = ?, updated_at = ? WHERE id = ?",
      [stamp, actorName(auth), stamp, r.id]
    );
  }
  await writeAudit(env, auth, {
    action: 'update',
    entity: 'alerts',
    entityId: 'all',
    after: { acknowledged: open.length },
  });
  return json({ ok: true, acknowledged: open.length });
}

async function handleAlerts(pathname, method, url, request, env, auth) {
  const m = String(method || '').toUpperCase();
  const sub = pathname.replace(/^\/api\/alerts/, '');

  if (m === 'GET' && (sub === '' || sub === '/')) return listAlerts(url, env);
  if (m === 'GET' && sub === '/summary') return alertSummary(env);
  if (m === 'POST' && sub === '/acknowledge-all') return acknowledgeAll(env, auth);
  const ack = sub.match(/^\/([^/]+)\/acknowledge$/);
  if (m === 'POST' && ack) return acknowledgeOne(ack[1], request, env, auth);

  return null;
}

export { handleAlerts, RULE_IDS, SEVERITY };
