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
 *  2. Per-role access IS now enforced, by resource rather than by screen. The
 *     earlier note here said gating reads by the frontend's ROLE_PERMISSIONS
 *     would break working pages, and it would: Cashier's Time Clock reads
 *     `staff`, Head Chef's Reports reads `expenses`, Head Chef's Orders reads
 *     `menu`, and Cleaner's Dashboard reads `tables`. None of those resources
 *     appear in the corresponding role's screen list.
 *
 *     So the matrix below is not derived from ROLE_PERMISSIONS. It was built by
 *     reading what each screen actually fetches and taking the union per role,
 *     which is why it grants reads that look surprising. Every one of them is
 *     load-bearing; removing one blanks a page.
 *
 *     Until this existed, any signed-in member of staff could read every
 *     endpoint. A chef session returned 200 for /api/staff, /api/expenses,
 *     /api/cashdrawer and /api/tables - screens the UI carefully hides from
 *     them. Hiding a link was the only thing standing in the way.
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

/**
 * Endpoints any signed-in member of staff may reach, whatever their role.
 * Session housekeeping, plus the shared catalogue and CMS reads that the app
 * chrome needs on every screen.
 */
const ANY_STAFF_READ = new Set(['menu', 'content', 'gallery', 'reviews']);

/**
 * Resource access per role.
 *
 * `read` covers GET; `write` covers POST, PUT, PATCH and DELETE. A resource
 * absent from both lists is refused. Manager is deliberately unrestricted -
 * every screen in the application is theirs.
 *
 * The reads that look wrong are the ones to leave alone:
 *   head-chef  -> expenses   Reports fetches expenses unconditionally
 *   cashier    -> staff      Time Clock lists who is on shift
 *   cleaner    -> tables     their Dashboard counts tables needing attention
 *   every POS role -> menu   order screens render dish names and prices
 */
const ROLE_ACCESS = {
  manager: { read: '*', write: '*' },

  'head-chef': {
    read: ['orders', 'inventory', 'waste', 'expenses'],
    // menu-availability lets them 86 a dish that has run out. The menu itself
    // stays manager-only, so pricing is untouched.
    write: ['orders', 'inventory', 'waste', 'menu-availability'],
  },
  // Reads stock, does not own it. Monitoring levels, ordering supplies and
  // controlling food cost belong to the head chef; an assistant executes
  // against those counts, and two people adjusting the same figures is how a
  // stock take stops reconciling.
  'assistant-chef': {
    read: ['orders', 'inventory'],
    write: ['orders'],
  },
  'head-waiter': {
    read: ['orders', 'tables', 'reservations'],
    write: ['orders', 'tables', 'reservations'],
  },
  cashier: {
    read: ['orders', 'tables', 'reservations', 'expenses', 'staff', 'timeclock', 'cashdrawer'],
    write: ['orders', 'tables', 'reservations', 'timeclock', 'cashdrawer'],
  },
  'delivery-staff': {
    read: ['delivery'],
    write: ['delivery'],
  },
  cleaner: {
    read: ['waste', 'tables'],
    write: ['waste'],
  },
};

/**
 * The resource a path acts on.
 *
 * Several paths do not name their resource in the obvious way: /api/menus and
 * /api/menus/save are the menu, /api/save-content is content, and the SSE
 * streams are gated as the data they push rather than as a resource of their
 * own, so a cleaner cannot subscribe to the kitchen feed and receive orders
 * they may not fetch.
 */
export function resourceForPath(pathname) {
  const parts = String(pathname || '').split('/').filter(Boolean);
  if (parts[0] !== 'api' || parts.length < 2) return null;

  const head = parts[1];
  // Marking a dish unavailable is its own resource, so the head chef can 86
  // something without being granted the menu - which is where price, cost and
  // margin live. The endpoint itself reads only `available`, so this grant
  // cannot widen into repricing.
  if (head === 'menu' && parts[3] === 'availability') return 'menu-availability';
  if (head === 'menus') return 'menu';
  if (head === 'save-content') return 'content';
  if (head === 'events') return parts[2] === 'kitchen' ? 'orders' : 'tables';
  return head;
}

/**
 * Who to record against an audited action.
 *
 * getAuthUser returns { staff_id, sessionRole, firstName, lastName }, so the
 * obvious-looking `auth.name` / `auth.id` are all undefined. Every audit field
 * written before this existed recorded the string "unknown", which is worse
 * than recording nothing because it looks like an answer.
 */
export function actorName(auth) {
  if (!auth) return 'unknown';
  const full = [auth.firstName, auth.lastName].filter(Boolean).join(' ').trim();
  return full || String(auth.staff_id || 'unknown');
}

/** Session housekeeping is never role-gated; it is how a role is known at all. */
function isSessionRoute(pathname) {
  return pathname === '/api/auth/me' || pathname === '/api/auth/logout';
}

/**
 * Decide whether `role` may perform `method` on `pathname`.
 * Unknown roles and unlisted resources are refused rather than allowed: a
 * default-allow here is what let every session read everything.
 */
export function roleMayAccess(role, pathname, method) {
  const key = String(role || '').toLowerCase().replace(/\s+/g, '-');
  const access = ROLE_ACCESS[key];
  if (!access) return false;
  if (access.read === '*' && access.write === '*') return true;

  const resource = resourceForPath(pathname);
  if (!resource) return false;

  const reading = String(method || '').toUpperCase() === 'GET';
  if (reading && ANY_STAFF_READ.has(resource)) return true;

  const allowed = reading ? access.read : access.write;
  return Array.isArray(allowed) && allowed.includes(resource);
}

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

  // Signing out and checking who you are must never depend on what you may
  // reach, or a role with a narrow matrix could not end its own session.
  if (isSessionRoute(pathname)) {
    return { ok: true, auth };
  }

  if (!roleMayAccess(role, pathname, method)) {
    return {
      ok: false,
      response: json(
        {
          ok: false,
          error: `Your role does not have access to this data`,
          role: role || null,
          resource: resourceForPath(pathname),
        },
        403
      ),
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
