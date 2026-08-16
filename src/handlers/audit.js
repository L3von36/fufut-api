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

export async function handleAudit(pathname, method, url, env) {
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
