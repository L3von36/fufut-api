/**
 * Audit trail.
 *
 * Every mutating handler records what it changed here. The backoffice has shown
 * an "Audit Log" nav item since it was built and there was never a table behind
 * it, so price changes, discounts, refunds and stock adjustments all happened
 * with nothing written down.
 *
 * Two rules govern this module:
 *
 *  1. **It never throws.** An audit write that fails must not fail the action it
 *     describes. Refusing to take an order because the log is unavailable is a
 *     worse outcome than an incomplete log, and the same reasoning already
 *     governs insertOrderItems. Failures go to console.error, where the Worker's
 *     observability picks them up.
 *
 *  2. **It records the diff, not the row.** `before`/`after` hold only fields
 *     that actually changed. A full snapshot per write would outgrow the data it
 *     describes, and the question asked of an audit log is always "what moved",
 *     never "what did every other column say at the time".
 */

import { d1Run } from './db.js';
import { actorName } from '../auth.js';

/**
 * Fields that must never be copied into the log, whatever a handler passes.
 * The log is readable by managers and exportable to the accountant, so a
 * credential landing in it would outlive the row it came from.
 */
const NEVER_LOG = new Set(['password_hash', 'password', 'newPassword', 'currentPassword', 'token']);

/**
 * Reduce a before/after pair to only what differs.
 *
 * Values are compared after JSON serialisation so an unchanged object does not
 * register as a change purely from identity, which would make every update look
 * like it rewrote every column.
 */
export function diffFields(before, after) {
  const from = {};
  const to = {};
  if (!after || typeof after !== 'object') return { from, to };

  for (const key of Object.keys(after)) {
    if (NEVER_LOG.has(key)) continue;
    const a = before && typeof before === 'object' ? before[key] : undefined;
    const b = after[key];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    if (a !== undefined) from[key] = a;
    to[key] = b;
  }
  return { from, to };
}

function serialize(obj) {
  if (obj === null || obj === undefined) return null;
  const keys = Object.keys(obj);
  if (!keys.length) return null;
  try {
    return JSON.stringify(obj);
  } catch {
    return null;
  }
}

/**
 * Record one audited action.
 *
 * @param {object}  env
 * @param {object?} auth   the decision.auth from authorize(); null for anonymous
 *                         website actions, which are logged as such rather than
 *                         dropped — an online order still needs a trail.
 * @param {object}  entry
 * @param {string}  entry.action    create | update | void | refund | adjust | verify
 * @param {string}  entry.entity    orders | payments | inventory | menu | staff…
 * @param {string?} entry.entityId
 * @param {object?} entry.before    prior values (diffed against `after`)
 * @param {object?} entry.after     new values
 * @param {string?} entry.reason
 * @returns {Promise<boolean>} whether the row was written
 */
export async function writeAudit(env, auth, entry) {
  try {
    if (!entry || !entry.action || !entry.entity) return false;

    // When both sides are supplied this is an update and only the delta is
    // interesting. A create passes `after` alone and is stored whole.
    let before = entry.before || null;
    let after = entry.after || null;
    if (before && after) {
      const { from, to } = diffFields(before, after);
      // Nothing actually changed — an update that rewrote identical values is
      // noise, and logging it buries the writes that matter.
      if (!Object.keys(to).length) return false;
      before = from;
      after = to;
    } else if (after) {
      const { to } = diffFields(null, after);
      after = to;
    }

    await d1Run(
      env,
      `INSERT INTO audit_log
         (id, at, actor_id, actor_name, actor_role, action, entity, entity_id, before, after, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'AL' + crypto.randomUUID().slice(0, 10),
        new Date().toISOString(),
        (auth && auth.staff_id) || null,
        auth ? actorName(auth) : 'anonymous',
        (auth && (auth.sessionRole || auth.role)) || null,
        String(entry.action),
        String(entry.entity),
        entry.entityId ? String(entry.entityId) : null,
        serialize(before),
        serialize(after),
        entry.reason ? String(entry.reason) : null,
      ]
    );
    return true;
  } catch (e) {
    // Deliberately swallowed. See rule 1 above.
    console.error('[AUDIT]', entry && entry.entity, entry && entry.action, e);
    return false;
  }
}
