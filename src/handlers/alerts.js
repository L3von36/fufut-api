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
import { normaliseTableId } from '../lib/staleness.js';
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
  const [ordersStage, ordersUnpaid, deliveryJobs, reservations, tables, timeclockOpen] = await Promise.all([
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
    d1Query(
      env,
      "SELECT t.*, s.firstName, s.lastName FROM timeclock t LEFT JOIN staff s ON s.id = t.staff_id " +
      "WHERE t.clock_out IS NULL OR t.clock_out = '' ORDER BY t.clock_in"
    ),
  ]);
  return {
    orders: [...(ordersStage.results || []), ...(ordersUnpaid.results || [])],
    deliveryJobs: deliveryJobs.results || [],
    reservations: reservations.results || [],
    tables: tables.results || [],
    timeclockEntries: timeclockOpen.results || [],
  };
}

/**
 * Stamp each order row with the name of the waiter its table is assigned to
 * (`table_server`), so a ready-now ping can name — and be aimed at — the
 * person waiting on it. A JS join because orders.table_id spells one table
 * three ways ("T-01", "Table 1", "1"); the same normalisation the sweep's
 * own rules use folds them together.
 */
function withTableServers(orders, tables) {
  if (!orders || !orders.length) return orders;
  const serverByTable = new Map();
  for (const t of tables || []) {
    const key = normaliseTableId(t.number);
    if (key) serverByTable.set(key, String(t.server || '').trim());
  }
  for (const o of orders) {
    o.table_server = serverByTable.get(normaliseTableId(o.table_id || o.table_number)) || '';
  }
  return orders;
}

/**
 * Map of "first last" (lowercased, the way tables.server writes it) to the
 * staff id, for stamping ready-now pings with their intended reader. One
 * query per sweep, built only when a ping actually needs it.
 */
async function loadStaffByName(env) {
  try {
    const { results } = await d1Query(env, 'SELECT id, firstName, lastName FROM staff');
    const map = new Map();
    for (const s of results || []) {
      const full = [s.firstName, s.lastName].filter(Boolean).join(' ').trim().toLowerCase();
      if (full && s.id) map.set(full, s.id);
    }
    return map;
  } catch {
    return new Map();
  }
}

/**
 * Who a ready-now ping is for: the waiter assigned to the table, else the
 * staff member who created the order (takeaways ring up under a person),
 * else nobody — an untargeted row broadcasts to every head-waiter.
 */
function resolveReadyNowTarget(v, staffByName) {
  const byName = v.target_name && staffByName.get(String(v.target_name).trim().toLowerCase());
  if (byName) return byName;
  const creator = String(v.created_by || '').trim();
  return creator || '';
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
  withTableServers(rows.orders, rows.tables);
  const violations = evaluateAll(rows, Date.now(), th);

  // Ready-now pings name a person: resolve tables.server / created_by to a
  // staff id here, so the audience filter can aim the row. One staff read
  // per sweep, only when a ping is live.
  let staffByName = null;
  for (const v of violations) {
    if (v.rule_id !== RULE_IDS.READY_NOW) continue;
    if (!staffByName) staffByName = await loadStaffByName(env);
    v.target_staff_id = resolveReadyNowTarget(v, staffByName);
  }

  const wanted = new Map();
  for (const v of violations) wanted.set(dedupeKey(v), v);

  // Every row still telling its story, acked or not. An acked row suppresses
  // re-raising; a resolved row is forgotten here on purpose.
  const { results: live } = await d1Query(
    env,
    "SELECT id, rule_id, entity_type, entity_id, severity, status, station, target_staff_id FROM alerts WHERE status IN ('open','acknowledged')"
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
        `INSERT INTO alerts (id, rule_id, severity, entity_type, entity_id, entity_label, message, status, station, target_staff_id, created, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
        [vid(), v.rule_id, v.severity, v.entity_type, v.entity_id, v.entity_label || '', v.message, v.station || '', v.target_staff_id || '', stamp, stamp]
      );
      raised += 1;
      continue;
    }
    // Severity moves with the condition while the alert is open: a ticket
    // that crossed from warning into critical must say so, and one that was
    // re-timed back under must not keep shouting. Station and target are
    // refreshed the same way — a legacy row picks up its station on the
    // first sweep that can classify it, and a ping re-aims if the table's
    // assignment changed. Acked rows are the floor's problem now.
    if (row.status === 'open' && (
      row.severity !== v.severity ||
      String(row.station || '') !== String(v.station || '') ||
      String(row.target_staff_id || '') !== String(v.target_staff_id || '')
    )) {
      await d1Run(
        env,
        'UPDATE alerts SET severity = ?, message = ?, station = ?, target_staff_id = ?, updated_at = ? WHERE id = ?',
        [v.severity, v.message, v.station || '', v.target_staff_id || '', stamp, row.id]
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

/**
 * Who should see each alert rule.
 *
 * Before this map existed, every role with `alerts` read permission saw every
 * open alert — so the chef's kitchen tablet showed "Table 3 seated 1h 31min"
 * and "Takeaway served 30 min ago, bill still open", neither of which the
 * kitchen can act on. The chef ignored the banner, which is the same as not
 * having one.
 *
 * The map is keyed by `rule_id` (stable strings from RULE_IDS) and each entry
 * describes its audience in one of three shapes:
 *
 *   { all: [roles] }          — every row of this rule goes to every listed
 *                               role (money rules, floor rules, HR rules).
 *   { kitchen: […], bar: […] } — order-stage rules split by STATION: the row's
 *                               `station` column ('bar' | 'kitchen' | 'mixed'
 *                               | '' legacy) picks the bucket. 'mixed' reaches
 *                               both buckets — both stations hold unfinished
 *                               lines on that ticket. '' (unclassifiable legacy
 *                               rows) lands in the kitchen bucket, which was
 *                               the audience before the split existed.
 *   { targeted: [roles] }     — rows meant for one person: the pickup ping is
 *                               stamped with `target_staff_id` (the waiter
 *                               assigned to the table, else the order's
 *                               creator). A targeted role sees rows with no
 *                               target or with their own id — a cashier never
 *                               receives the chef's table ping.
 *
 * The manager is deliberately absent from every list: they bypass the map and
 * see everything, because they are the floor's fallback for any problem.
 *
 * Filtering by `rule_id` + station rather than `entity_type` is deliberate:
 * an order can be the entity behind five different rules with five different
 * audiences, and `entity_type='order'` alone cannot tell them apart.
 */
const RULE_AUDIENCE = {
  // Kitchen's clock, kitchen's job — and the bar's clock, the barista's job.
  // A tea ticket nobody accepted is a bar problem; before the station split
  // these all rang on the kitchen tablet while the drinks sat.
  'order-preparing-too-long':     { kitchen: ['head-chef', 'assistant-chef'], bar: ['barista'] },
  'order-new-unaccepted':         { kitchen: ['head-chef', 'assistant-chef'], bar: ['barista'] },
  // Kitchen marked it ready, but the waiter is who needs to fetch it. The
  // station that made it also needs to see it sitting. A drink ready on the
  // pass is the barista's + the waiter's; food ready is kitchen + waiter.
  'order-ready-not-served':       { kitchen: ['head-chef', 'assistant-chef', 'head-waiter'], bar: ['barista', 'head-waiter'] },
  // The instant pickup ping. Targeted at the assigned waiter (fallback: the
  // order's creator, then every head-waiter). Cashier is in the list for the
  // takeaway case — a takeaway ticket they rung up pings them, not the floor.
  'order-ready-now':              { targeted: ['head-waiter', 'cashier'] },
  // Money on the floor. Cashier owns it; head-waiter can remind the guest.
  // The kitchen has no part in this — before the audience map, the pass was
  // reading "bill still open" between tickets.
  'order-served-unpaid':          { all: ['cashier', 'head-waiter'] },
  'delivery-ready-unassigned':    { all: ['delivery-staff'] },
  'delivery-in-transit-too-long': { all: ['delivery-staff'] },
  'reservation-no-show':          { all: ['head-waiter'] },
  'table-seated-too-long':        { all: ['head-waiter'] },
  // People clocks are the manager's alone — no other role can act on them.
  'employee-forgot-clock-out':    { all: [] },
  'employee-late-arrival':        { all: [] },
};

/**
 * Can this auth see this alert row? The single source of truth for every
 * surface that serves alerts — the list endpoint, the SSE channel and the
 * acknowledge gate all call this, so the three can never disagree about who
 * saw what (the drift this replaces is exactly how one dashboard ended up
 * reading another's alerts).
 */
function alertVisibleTo(row, auth) {
  if (!row) return false;
  const role = String((auth && (auth.sessionRole || auth.role)) || '').toLowerCase();
  if (!role) return false;
  if (role === 'manager') return true; // the floor's fallback sees everything
  const spec = RULE_AUDIENCE[row.rule_id];
  if (!spec) return false; // unknown rule — manager-only by definition

  if (spec.all) return spec.all.includes(role);

  if (spec.targeted) {
    if (!spec.targeted.includes(role)) return false;
    const target = String(row.target_staff_id || '').trim();
    if (!target) return true; // untargeted row: broadcast to the whole list
    // A targeted row is for one person. If the session carries no staff id
    // (defensive — sessions always do), fail closed rather than leak.
    const myId = String((auth && auth.staff_id) || '');
    return !!myId && target === myId;
  }

  const station = String(row.station || '').toLowerCase();
  const inBucket = (names) => Array.isArray(names) && names.includes(role);
  if (station === 'bar') return inBucket(spec.bar);
  if (station === 'mixed') return inBucket(spec.bar) || inBucket(spec.kitchen);
  // '', 'kitchen' and anything unreadable land in the kitchen bucket — the
  // audience the pre-station rows were written for.
  return inBucket(spec.kitchen);
}

/**
 * The rule_ids a given role could see at least some rows of, as a SQL
 * IN-list (index-friendly pre-filter). Returns `null` for a manager — they
 * see every rule, so no WHERE clause is needed — and `[]` for a role with no
 * audience at all. Rows are then refined by alertVisibleTo, so this list is
 * an optimisation, never the permission itself.
 */
function allowedRuleIdsForRole(auth) {
  if (!auth) return [];
  const role = String((auth && (auth.sessionRole || auth.role)) || '').toLowerCase();
  if (!role) return [];
  if (role === 'manager') return null; // manager sees everything
  const allowed = new Set();
  for (const [ruleId, spec] of Object.entries(RULE_AUDIENCE)) {
    if (spec.all) {
      if (spec.all.includes(role)) allowed.add(ruleId);
      continue;
    }
    if (spec.targeted) {
      if (spec.targeted.includes(role)) allowed.add(ruleId);
      continue;
    }
    const buckets = [spec.kitchen, spec.bar];
    if (buckets.some((b) => Array.isArray(b) && b.includes(role))) allowed.add(ruleId);
  }
  return [...allowed];
}

/**
 * Back-compat shim — the pre-station filter by rule_id alone. The SSE
 * handler and tests used this name; both callers now use the pair above.
 */
function ruleWhitelistForRole(auth) {
  return allowedRuleIdsForRole(auth);
}

/** GET /api/alerts — open by default, ?status=… or ?all=1 to widen. */
async function listAlerts(url, env, auth) {
  const wantsAll = ['1', 'true', 'yes'].includes(String(url.searchParams.get('all') || '').toLowerCase());
  const statusParam = String(url.searchParams.get('status') || 'open').toLowerCase().trim();
  const limitRaw = num(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 200;

  // Role-targeted filtering: only managers see every alert. Everyone else
  // sees only the rules in their audience — refined per row by station (a
  // chef sees kitchen tickets, the barista sees bar tickets) and by target
  // (a pickup ping aimed at another waiter stays theirs). Applied on top of
  // the status filter so a head-chef asking for ?status=acknowledged still
  // only sees kitchen-relevant acked rows, not the cashier's.
  const allowedRules = allowedRuleIdsForRole(auth);
  // `wantsAll` is a manager's tool (the SLA Alerts dashboard "show history"
  // toggle). A non-manager who somehow passes ?all=1 still gets the
  // role filter applied — they cannot widen their view by adding a param.
  const managerSeesAll = allowedRules === null;

  let rows;
  if (wantsAll && managerSeesAll) {
    ({ results: rows } = await d1Query(env, 'SELECT * FROM alerts ORDER BY created DESC LIMIT ?', [limit]));
  } else {
    const status = ['open', 'acknowledged', 'resolved'].includes(statusParam) ? statusParam : 'open';
    if (managerSeesAll) {
      ({ results: rows } = await d1Query(env, 'SELECT * FROM alerts WHERE status = ? ORDER BY created DESC LIMIT ?', [status, limit]));
    } else if (allowedRules.length === 0) {
      // Role is not in any audience — return nothing rather than every row
      // the gate would otherwise expose. (Defense in depth: the auth matrix
      // should also refuse them the resource, but if it ever lets them
      // through, this is the second door.)
      rows = [];
    } else {
      // SQL narrows by rule_id (cheap index work); station and target are
      // row-level judgements, applied here so the list endpoint, the SSE
      // channel and the ack gate share one implementation.
      const placeholders = allowedRules.map(() => '?').join(',');
      ({ results: rows } = await d1Query(
        env,
        `SELECT * FROM alerts WHERE status = ? AND rule_id IN (${placeholders}) ORDER BY created DESC LIMIT ?`,
        [status, ...allowedRules, limit]
      ));
      rows = (rows || []).filter((r) => alertVisibleTo(r, auth));
    }
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

  // Defense-in-depth on top of the role-targeted filter: even if a non-manager
  // somehow obtains the id of an alert outside their audience, they cannot ack
  // it. The same RULE_AUDIENCE map that gates listAlerts gates this — a chef
  // cannot ack a table-seated or served-unpaid alert, and a cashier cannot
  // ack a kitchen ticket's alert by id.
  if (!alertVisibleTo(row, auth)) {
    return json({ ok: false, error: 'Not permitted: this alert is for a different role' }, 403);
  }

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

  if (m === 'GET' && (sub === '' || sub === '/')) return listAlerts(url, env, auth);
  if (m === 'GET' && sub === '/summary') return alertSummary(env);
  if (m === 'POST' && sub === '/acknowledge-all') return acknowledgeAll(env, auth);
  const ack = sub.match(/^\/([^/]+)\/acknowledge$/);
  if (m === 'POST' && ack) return acknowledgeOne(ack[1], request, env, auth);

  return null;
}

export { handleAlerts, listAlerts, alertVisibleTo, allowedRuleIdsForRole, ruleWhitelistForRole, RULE_AUDIENCE, RULE_IDS, SEVERITY };
