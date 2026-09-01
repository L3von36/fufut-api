/**
 * Reading the audit trail.
 *
 * Writing is in lib/audit.js; this is the query side that the backoffice's
 * "Audit Log" screen reads. The screen has existed since the backoffice was
 * built and has never had anything behind it.
 *
 * Read-only by design — there is no endpoint here that edits or removes an
 * entry. A log that can be amended by the people it records answers nothing,
 * and §37 of the spec turns on being able to trust it later.
 */

import { d1Query, json } from '../lib/db.js';

const MAX_LIMIT = 500;

/**
 * Entity types each role is allowed to see in their own audit log.
 *
 * The self-scoped carve-out in auth.js lets any signed-in user read their
 * own audit entries. Without this map, a cleaner who triggered an audit
 * event for `staff` (unlikely but possible via a task assignment) would
 * see staff salary data in the `after` JSON payload. This map ensures a
 * non-manager only sees audit entries for entity types their role is
 * allowed to read — same principle as the alerts RULE_AUDIENCE filter.
 *
 * Manager and accountant see everything (they hold the `audit` resource
 * read grant in the role matrix, so they don't go through the self-scoped
 * path at all — they see the full trail).
 *
 * The entity types map to the ROLE_ACCESS read lists in auth.js:
 * a role that cannot read `staff` should not see `staff` audit entries
 * even if they somehow triggered one.
 */
const ENTITY_AUDIENCE = {
  manager: null, // sees everything
  accountant: null, // sees everything (has audit read grant)

  'head-chef': new Set([
    'orders', 'inventory', 'waste', 'recipes', 'menu', 'menu-availability',
    'alerts', 'timeclock', 'break', 'task', 'handover',
  ]),
  'assistant-chef': new Set([
    'orders', 'inventory', 'recipes', 'menu',
    'alerts', 'timeclock', 'break', 'task', 'handover',
  ]),
  // The barista touches only order lines and their own clock: no stock
  // movements, no recipes, no menu edits. Their self-scoped audit view should
  // not imply otherwise, so the list is narrower than the chefs' on purpose.
  barista: new Set([
    'orders', 'timeclock', 'break', 'handover',
  ]),
  'head-waiter': new Set([
    'orders', 'tables', 'reservations', 'tips',
    'alerts', 'timeclock', 'break', 'task', 'handover',
  ]),
  cashier: new Set([
    'orders', 'tables', 'payments', 'tips', 'cashdrawer',
    'reservations', 'timeclock',
    'alerts', 'break', 'task', 'handover',
  ]),
  'delivery-staff': new Set([
    'delivery', 'orders', 'payments', 'tips',
    'timeclock', 'break', 'task', 'handover',
  ]),
  cleaner: new Set([
    'waste', 'tables',
    'timeclock', 'break', 'task', 'handover',
  ]),
};

export async function handleAudit(pathname, method, url, env, auth) {
  if (method.toUpperCase() !== 'GET') {
    if (pathname.startsWith('/api/audit')) {
      return json({ ok: false, error: 'The audit log is written by the system and is read-only' }, 405);
    }
    return null;
  }

  if (pathname !== '/api/audit' && pathname !== '/api/audit-log') return null;

  const clauses = [];
  const params = [];

  const entity = url.searchParams.get('entity');
  const entityId = url.searchParams.get('entity_id') || url.searchParams.get('entityId');
  const actor = url.searchParams.get('actor_id') || url.searchParams.get('actorId');
  const action = url.searchParams.get('action');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');

  if (entity) { clauses.push('entity = ?'); params.push(entity); }
  if (entityId) { clauses.push('entity_id = ?'); params.push(entityId); }
  if (actor) { clauses.push('actor_id = ?'); params.push(actor); }
  if (action) { clauses.push('action = ?'); params.push(action); }
  if (from) { clauses.push('at >= ?'); params.push(from); }
  if (to) { clauses.push('at <= ?'); params.push(to); }

  // Entity-type filter for non-managers reading their own audit log.
  // A role that cannot read `staff` should not see `staff` entries even
  // if they somehow triggered one. Manager and accountant see everything.
  const role = String((auth && (auth.sessionRole || auth.role)) || '').toLowerCase();
  const allowedEntities = ENTITY_AUDIENCE[role];
  if (allowedEntities !== null && allowedEntities !== undefined) {
    const placeholders = [...allowedEntities].map(() => '?').join(',');
    clauses.push(`entity IN (${placeholders})`);
    params.push(...allowedEntities);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 100));

  const { results } = await d1Query(
    env,
    `SELECT * FROM audit_log ${where} ORDER BY at DESC LIMIT ?`,
    [...params, limit]
  );

  // before/after are stored as JSON text. Parsing here means the screen renders
  // a diff rather than a string of braces, and a row written by an older
  // version that stored something unparseable is passed through rather than
  // failing the whole page.
  const rows = (results || []).map((r) => {
    const parse = (v) => {
      if (!v) return null;
      try { return JSON.parse(v); } catch { return v; }
    };
    return { ...r, before: parse(r.before), after: parse(r.after) };
  });

  return json({ ok: true, count: rows.length, entries: rows });
}
