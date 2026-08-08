/**
 * Authorization layer.
 *
 * Background: the deployed Worker defined getAuthUser() and never called it, so
 * every endpoint answered unauthenticated — staff phone numbers, customer
 * reservations, orders and revenue were readable by anyone with the URL. An
 * older Hono build of this same API applied requireAuth() to 13 routes; that
 * enforcement was lost in a rewrite. This module restores it.
 *
 * Two rules govern the design:
 *
 *  1. The public website (fufutcoffee.com) is served by this same Worker. It
 *     reads content/menus/reviews/images and *writes* reservations, orders and
 *     reviews as an anonymous customer. Those must stay open or online booking
 *     and ordering break. Everything else requires a session.
 *
 *  2. Per-role *read* restrictions are deliberately NOT applied yet. Several
 *     POS pages legitimately read data outside their role's permission list —
 *     Cashier's Time Clock reads `staff`, Head Chef's Reports reads `expenses`,
 *     Head Chef's Orders reads `menu`. Gating reads by the frontend's
 *     ROLE_PERMISSIONS would break those working pages. Closing the public hole
 *     is the urgent fix; tightening per-role reads needs the permission model
 *     reworked first (see FIX-PROMPT.md Task 5).
 */

import { json } from './lib/db.js';
import { getAuthUser } from './handlers/session.js';

/** Routes reachable with no session at all. */
const PUBLIC = [
  // Staff sign-in.
  { method: 'POST', exact: '/api/auth/login' },

  // Website CMS + catalogue reads.
  { method: 'GET', exact: '/api/content' },
  { method: 'GET', exact: '/api/menu' },
  { method: 'GET', exact: '/api/menus' },
  { method: 'GET', exact: '/api/reviews' },
  { method: 'GET', prefix: '/api/images/' },

  // Anonymous customer actions from the website. Removing these breaks online
  // booking, online ordering and review submission.
  { method: 'POST', exact: '/api/reservations' },
  { method: 'POST', exact: '/api/orders' },
  { method: 'POST', exact: '/api/reviews' },
];

/**
 * Operations restricted to managers regardless of session. These either expose
 * payroll-adjacent data, mutate other people's accounts, or can destroy data.
 */
const MANAGER_ONLY = [
  { method: 'POST', prefix: '/api/migrate/' },
  { method: 'POST', prefix: '/api/staff' },
  { method: 'PUT', prefix: '/api/staff' },
  { method: 'DELETE', prefix: '/api/staff' },
];

function matches(rules, pathname, method) {
  return rules.some((r) => {
    if (r.method && r.method !== method) return false;
    if (r.exact) return r.exact === pathname;
    if (r.prefix) return pathname.startsWith(r.prefix);
    return false;
  });
}

function isManager(role) {
  return String(role || '').toLowerCase() === 'manager';
}

/**
 * Decide whether a request may proceed.
 *
 * @returns {{ok: true, auth: object|null} | {ok: false, response: Response}}
 */
export async function authorize(request, env, pathname, method) {
  if (matches(PUBLIC, pathname, method)) {
    return { ok: true, auth: null };
  }

  const auth = await getAuthUser(request, env);
  if (!auth) {
    return {
      ok: false,
      response: json({ ok: false, error: 'Authentication required' }, 401),
    };
  }

  const role = auth.sessionRole || auth.role;
  if (matches(MANAGER_ONLY, pathname, method) && !isManager(role)) {
    return {
      ok: false,
      response: json({ ok: false, error: 'Manager access required' }, 403),
    };
  }

  return { ok: true, auth };
}

/**
 * Strip colleague contact details from staff listings for anyone who is not a
 * manager. Time Clock and Shifts legitimately need names and roles, so those
 * stay; personal phone numbers and emails do not.
 */
export function redactStaffForRole(payload, role) {
  const manager = isManager(role);
  const scrub = (row) => {
    if (!row || typeof row !== 'object') return row;
    // password_hash is stripped for everyone, always. mapResourceRow already
    // removes it upstream; doing it here too means a new read path cannot
    // reintroduce the leak.
    const { password_hash, phone, email, ...rest } = row;
    return manager ? { ...rest, phone, email } : rest;
  };
  return Array.isArray(payload) ? payload.map(scrub) : scrub(payload);
}

export { isManager };
