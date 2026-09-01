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
  { method: 'GET', exact: '/api/stats' },
  // Whether the venue can take an order at all. Public because the website
  // needs it before a customer has done anything.
  { method: 'GET', exact: '/api/venue/status' },
  { method: 'GET', exact: '/api/menu' },
  { method: 'GET', exact: '/api/menus' },
  { method: 'GET', exact: '/api/reviews' },
  // Menu and gallery images, which the public website renders. Payment evidence
  // also lives in R2 and must NOT be reachable this way — see isPrivateImage.
  { method: 'GET', prefix: '/api/images/' },

  // Anonymous customer actions from the website. Removing these breaks online
  // booking, online ordering and review submission.
  { method: 'POST', exact: '/api/reservations' },
  { method: 'POST', exact: '/api/orders' },
  { method: 'POST', exact: '/api/reviews' },
];

/**
 * The writes above, but seen from the other side: they are open to a caller
 * with NO session, and to nobody else.
 *
 * PUBLIC is matched before the session is resolved, so before this set
 * existed a signed-in member of staff hit the anonymous rule first: a cleaner,
 * an accountant or a driver could POST /api/orders (or a reservation, or a
 * review) even though their role holds no such write. Found live in the
 * four-role smoke of 2026-08-26 — all three roles created an order with a 200.
 *
 * /api/auth/login is deliberately not here: it establishes the session and
 * must work whatever stale session the request already carries.
 */
const ANONYMOUS_WRITES = new Set([
  '/api/orders',
  '/api/reservations',
  '/api/reviews',
]);

/**
 * Operations restricted to managers regardless of session. These either expose
 * payroll-adjacent data, mutate other people's accounts, or can destroy data.
 */
const MANAGER_ONLY = [
  { method: 'POST', prefix: '/api/migrate/' },
  { method: 'POST', prefix: '/api/staff' },
  { method: 'PUT', prefix: '/api/staff' },
  { method: 'DELETE', prefix: '/api/staff' },
  // Issuing somebody else a new password is an account takeover in one call.
  { method: 'POST', exact: '/api/auth/reset-password' },
  // Changing a password at all, including one's own.
  //
  // The business's decision: the manager provisions every credential and staff
  // do not alter them. That is a deliberate trade — it removes self-service
  // rotation and means the manager knows every password, in exchange for one
  // person being accountable for who can get into the till.
  //
  // It only works because `must_change_password` is no longer set (see
  // handlers/staff.js and session.js). With that flag set and this route
  // manager-only, an ordinary account would be refused every endpoint including
  // the one route it is allowed, and would be unable to do anything at all.
  { method: 'POST', exact: '/api/auth/change-password' },
  // Tax bands, pension rates and overtime multipliers. Changing one silently
  // changes what every future payslip pays out, so it stays with the person
  // answerable for it — and the change is audited.
  { method: 'PUT', prefix: '/api/settings' },
  // Running payroll commits the business to paying people.
  { method: 'POST', exact: '/api/payroll/run' },
];

/**
 * Reachable while an account is required to change its password. Everything
 * else is refused until it does, so the requirement is enforced here rather
 * than left to the client to honour - a stale tab or a direct API call would
 * otherwise carry on working on a credential the manager just handed out.
 */
const PASSWORD_CHANGE_ALLOWED = new Set([
  '/api/auth/change-password',
  '/api/auth/logout',
  '/api/auth/me',
]);

/**
 * Endpoints any signed-in member of staff may reach, whatever their role.
 * Session housekeeping, plus the shared catalogue and CMS reads that the app
 * chrome needs on every screen.
 */
// `units` is a static catalogue of grams, litres and pieces — the same list the
// conversion engine uses. It carries no business data, and gating it would mean
// a recipe editor whose unit dropdown is empty for some roles.
// `settings` is readable by any signed-in member of staff because the checkout
// needs the service charge and VAT to compute a bill, and the kitchen screens
// need the grace period. Writing it is manager-only (see MANAGER_ONLY), which
// is where the control belongs — the values are business policy, not secrets.
const ANY_STAFF_READ = new Set(['menu', 'content', 'gallery', 'reviews', 'units', 'settings']);

/**
 * Clocking yourself in and out, and asking whether you are on shift.
 *
 * Every role has to be able to do this. The shift gate exists to stop a waiter
 * going home with money still owed on their tables, and a waiter has no
 * `timeclock` grant at all. Granting them the resource would be the wrong fix:
 * `timeclock` write through the generic handler is the power to rewrite
 * anybody's hours, which is a payroll figure.
 *
 * So these four routes are open to any signed-in member of staff, and the
 * handler restricts them to the caller's own record — a staffId is honoured
 * only for a manager, who is the person already trusted with the roster.
 *
 * `/me/history` is read-only and answers only the caller's own shifts, so a
 * role with no `timeclock` grant (a waiter) can still see the hours they
 * themselves worked without being able to see anybody else's.
 */
const SELF_SERVICE = new Set([
  '/api/timeclock/me',
  '/api/timeclock/me/history',
  '/api/timeclock/clock-in',
  '/api/timeclock/clock-out',
  '/api/timeclock/break-start',
  '/api/timeclock/break-end',
  '/api/handovers',
  '/api/handovers/latest',
]);

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
    // Recipes, stock movements and suppliers all belong to the person who owns
    // food cost. Purchases are readable — they need to see what arrived and at
    // what price — but committing spend stays with the manager.
    read: ['orders', 'inventory', 'waste', 'expenses', 'recipes', 'units', 'suppliers', 'purchases', 'alerts', 'tasks'],
    // menu-availability lets them 86 a dish that has run out. The menu itself
    // stays manager-only, so pricing is untouched. Acknowledging an alert is
    // a kitchen act — "I have this ticket" — so the board's owner signs it.
    write: ['orders', 'inventory', 'waste', 'menu-availability', 'recipes', 'alerts', 'tasks'],
  },
  // Reads stock, does not own it. Monitoring levels, ordering supplies and
  // controlling food cost belong to the head chef; an assistant executes
  // against those counts, and two people adjusting the same figures is how a
  // stock take stops reconciling.
  'assistant-chef': {
    // Reads recipes because they cook from them; writes none of it, for the
    // same reason they do not own the stock counts. Reads alerts because the
    // ticket going late is theirs to rescue — they just cannot sign it off.
    read: ['orders', 'inventory', 'recipes', 'units', 'alerts', 'tasks'],
    write: ['orders'],
  },
  // The drinks station. Since order lines route by category — food to the
  // kitchen board, drinks to the barista board — the barista's entire job
  // against the API is reading the active lines and advancing them, so
  // `orders` read/write is the whole grant. Everything else the board needs
  // arrives through the standing carve-outs: menu, settings and units are
  // readable by any signed-in staff (ANY_STAFF_READ), clocking in and out is
  // self-service (SELF_SERVICE), and My Activity rides the self-scoped audit
  // read. No inventory, recipes, menu-availability or alerts: stock counts and
  // 86ing drinks stay with the chefs and the manager, and the SLA banner's
  // silent-fail on a refused /api/alerts is the same treatment a cleaner gets.
  barista: {
    read: ['orders'],
    write: ['orders'],
  },
  'head-waiter': {
    // Reads payments to see whether a table has settled before clearing it, and
    // writes tips because a tip left on the table is theirs to record. Cannot
    // write payments: taking the money is the cashier's, and a floor tablet
    // that can mark a bill paid is a hole with no compensating control.
    read: ['orders', 'tables', 'reservations', 'payments', 'tips', 'alerts', 'tasks'],
    write: ['orders', 'tables', 'reservations', 'tips', 'alerts', 'tasks'],
  },
  cashier: {
    read: ['orders', 'tables', 'reservations', 'expenses', 'staff', 'timeclock', 'cashdrawer', 'payments', 'tips', 'delivery', 'alerts', 'tasks'],
    // `upload` is the transfer screenshot that §9 requires against a Telebirr,
    // CBE or bank payment. Without it the evidence has nowhere to go and the
    // verification step has nothing to verify against.
    write: ['orders', 'tables', 'reservations', 'timeclock', 'cashdrawer', 'payments', 'tips', 'delivery', 'upload', 'alerts', 'tasks'],
  },
  // A driver needs the order behind the job — what is in the bag, what it comes
  // to, and whether it is already paid — plus a way to record the cash or the
  // transfer taken on the doorstep and the tip that came with it. Recording is
  // not verifying: /payments/:id/verify refuses every role but cashier and
  // manager, so the money the driver reports is still checked by the till when
  // they get back.
  'delivery-staff': {
    read: ['delivery', 'orders', 'payments', 'tips', 'alerts', 'tasks'],
    // Uploads for the same reason as the cashier: the screenshot is taken on
    // the doorstep, and a driver who can record a transfer but not photograph
    // it has to write the reference on their hand and type it in later.
    write: ['delivery', 'payments', 'tips', 'upload'],
  },
  cleaner: {
    // `inventory` is read-only and is what makes their waste worth logging.
    // Waste that does not name a stock item cannot reduce stock — the Waste
    // screen falls back to free text without it, so a cleaner clearing a
    // spoiled tray would record the event and leave the shelf overstated,
    // which is the exact discrepancy the ledger exists to remove.
    // Reading stock is not adjusting it; they still hold no inventory write.
    read: ['waste', 'tables', 'inventory'],
    write: ['waste'],
  },

  /**
   * Accountant — §47 and §51. Reads the whole financial picture and changes
   * almost none of it.
   *
   * Writes only `expenses`, because recording a bill that arrived is
   * bookkeeping. Everything else is read-only on purpose: an accountant who can
   * edit the sales, the payments or the payroll they are reconciling is not
   * reconciling anything. They cannot reach `settings` either — the tax bands
   * are theirs to *advise* on, and a manager applies them, which keeps the
   * decision and the audit entry with the person answerable for it.
   */
  accountant: {
    read: [
      'reports', 'orders', 'payments', 'tips', 'expenses', 'purchases', 'suppliers',
      'staff', 'attendance', 'overtime', 'leave', 'adjustments', 'payroll',
      'inventory', 'cashdrawer', 'timeclock', 'shifts', 'audit',
    ],
    write: ['expenses'],
  },
};

/**
 * Resources every role that has a Reports or Revenue screen must be able to
 * read, or those screens render empty.
 *
 * Kept as a separate list rather than repeated per role, because the failure it
 * prevents — a nav item that opens onto nothing — is the one this matrix has
 * already caused once.
 */
for (const role of ['cashier', 'head-chef', 'head-waiter']) {
  ROLE_ACCESS[role].read.push('reports');
}

/**
 * The canonical form of a role: lowercase, hyphenated.
 *
 * Both permission matrices key on this form, and `roleMayAccess` has always
 * normalised before looking up — so "Head Chef" and "head-chef" have always
 * granted the same access. What that tolerance hid is that the *stored* values
 * drifted: production held "Cashier", "Head Chef" and "Manager" in title case
 * alongside a lone lowercase "cleaner".
 *
 * That mattered in one place. The backoffice role dropdown offers canonical
 * values, so `<select>` bound to a title-case role matched no option and
 * rendered blank for every existing member of staff — which looks exactly like
 * a missing feature, and which silently rewrote the value to canonical form for
 * anybody who did use it. Normalising on write means the two can no longer
 * disagree.
 */
export const ROLES = [
  'manager',
  'head-chef',
  'assistant-chef',
  'barista',
  'head-waiter',
  'cashier',
  'delivery-staff',
  'cleaner',
  'accountant',
];

export function canonicalRole(role) {
  const key = String(role || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  return ROLES.includes(key) ? key : null;
}

/**
 * The resource a path acts on.
 *
 * Several paths do not name their resource in the obvious way: /api/menus and
 * /api/menus/save are the menu, /api/save-content is content, and the SSE
 * streams are gated as the data they push rather than as a resource of their
 * own, so a cleaner cannot subscribe to the kitchen feed and receive orders
 * they may not fetch.
 */
/**
 * Routes the box talks to, authenticated machine-to-machine.
 *
 * No session is involved: the box is not a person and has no role. It holds a
 * shared secret and may do exactly these three things.
 */
const SYNC_MACHINE = new Set(['/api/sync/push', '/api/sync/pull', '/api/sync/status']);

/**
 * Compare two secrets without leaking how much of one is right.
 *
 * A plain `===` on strings returns as soon as it finds a difference, and the
 * time that takes is measurable across enough requests. Comparing digests
 * rather than the tokens themselves also removes the length as a signal — both
 * sides are always 32 bytes.
 */
async function secretsMatch(given, expected) {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(given)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

/**
 * The sync routes' own gate.
 *
 * With no SYNC_TOKEN configured the routes do not exist — 404 rather than 401,
 * because a deployment that has not switched sync on should not advertise that
 * it could. This is what keeps the currently deployed Worker's surface
 * unchanged.
 */
export async function authorizeSync(request, env) {
  if (!env || !env.SYNC_TOKEN) {
    return { ok: false, response: json({ ok: false, error: 'Not found' }, 404) };
  }

  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || !(await secretsMatch(token, String(env.SYNC_TOKEN)))) {
    return { ok: false, response: json({ ok: false, error: 'Sync authentication required' }, 401) };
  }

  // No staff identity: nothing downstream should mistake the box for a person.
  return { ok: true, auth: { sync: true, staff_id: null, sessionRole: null } };
}

export function resourceForPath(pathname) {
  const parts = String(pathname || '').split('/').filter(Boolean);
  if (parts[0] !== 'api' || parts.length < 2) return null;

  const head = parts[1];
  // A payment screenshot is part of the payment record, so whoever may write a
  // payment may attach evidence to it and whoever may read one may look at it.
  // Gating it as its own resource would mean maintaining two lists that have to
  // agree, and the failure when they drift is a driver who can record a
  // transfer but cannot photograph it.
  if (head === 'images' && isPrivateImage(pathname)) return 'payments';
  // Marking a dish unavailable is its own resource, so the head chef can 86
  // something without being granted the menu - which is where price, cost and
  // margin live. The endpoint itself reads only `available`, so this grant
  // cannot widen into repricing.
  if (head === 'menu' && parts[3] === 'availability') return 'menu-availability';
  if (head === 'menus') return 'menu';
  if (head === 'save-content') return 'content';
  if (head === 'events') {
    if (parts[2] === 'kitchen') return 'orders';
    if (parts[2] === 'alerts') return 'alerts';
    if (parts[2] === 'activity') return 'audit'; // manager+accountant only
    return 'tables';
  }
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

/**
 * Session housekeeping is never role-gated; it is how a role is known at all.
 *
 * `change-password` used to be here, so anybody signed in could change their
 * own. It is now manager-only (see MANAGER_ONLY) at the business's decision:
 * the manager provisions every credential. It is checked before this function
 * runs, so listing it here would have no effect either way — but leaving it
 * would misdescribe the rule to the next reader.
 */
export function isSessionRoute(pathname) {
  return (
    pathname === '/api/auth/me' ||
    pathname === '/api/auth/logout'
  );
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

/**
 * Image keys that must never be served to an anonymous request.
 *
 * `/api/images/` is public because the website renders menu and gallery photos
 * from it. Payment evidence is stored in the same bucket and would inherit that
 * — a transfer screenshot shows an account number, a name and an amount, and
 * anyone holding the key could fetch it without signing in.
 *
 * Keys are opaque and unguessable, but "hard to guess" is not an access
 * control: the key travels in payloads, logs and screenshots of the till.
 */
const PRIVATE_IMAGE_PREFIXES = ['payments/', 'receipts/'];

export function isPrivateImage(pathname) {
  if (!pathname.startsWith('/api/images/')) return false;
  let key = pathname.slice('/api/images/'.length);
  try {
    key = decodeURIComponent(key);
  } catch {
    // A malformed escape cannot be decoded, so it cannot be shown to be public.
    return true;
  }
  return PRIVATE_IMAGE_PREFIXES.some((p) => key.startsWith(p));
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
export async function authorize(request, env, pathname, method, url) {
  // Checked first, ahead of even the public list: these are the only routes
  // authenticated by a shared secret rather than by a person, and nothing else
  // should ever be able to widen them.
  //
  // `/api/sync/reconciliation` is deliberately NOT here. It is something a
  // manager reads, so it falls through to the ordinary session check, where
  // the role matrix resolves it as the `sync` resource — managers hold `*` and
  // no other role lists it.
  if (SYNC_MACHINE.has(pathname)) {
    return authorizeSync(request, env);
  }

  // A session is never treated as anonymous. The anonymous writes — booking,
  // ordering, reviewing from the website — stay open to a caller with no
  // session, but a signed-in member of staff goes through the role matrix like
  // any other request, so the anonymous rule cannot be used to sidestep a
  // write the role does not hold. Reads stay public to everyone regardless of
  // session, exactly as before.
  const anonymousWrite =
    String(method || '').toUpperCase() === 'POST' && ANONYMOUS_WRITES.has(pathname);

  // Checked before the public list, so a private key cannot be let through by
  // the broad /api/images/ prefix rule.
  if (matches(PUBLIC, pathname, method) && !isPrivateImage(pathname) && !anonymousWrite) {
    return { ok: true, auth: null };
  }

  const auth = await getAuthUser(request, env);
  if (!auth) {
    if (anonymousWrite && !isPrivateImage(pathname)) {
      return { ok: true, auth: null };
    }
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

  // An account carrying a manager-issued password may do exactly one thing:
  // replace it. Checked before the role matrix, because the requirement applies
  // whatever the role.
  if (auth.must_change_password === 1 && !PASSWORD_CHANGE_ALLOWED.has(pathname)) {
    return {
      ok: false,
      response: json(
        {
          ok: false,
          error: 'You must change your password before continuing',
          mustChangePassword: true,
        },
        403
      ),
    };
  }

  // Signing out and checking who you are must never depend on what you may
  // reach, or a role with a narrow matrix could not end its own session.
  if (isSessionRoute(pathname)) {
    return { ok: true, auth };
  }

  // Clocking on and off is everyone's, and is scoped to the caller inside the
  // handler rather than by the role matrix. See SELF_SERVICE.
  if (SELF_SERVICE.has(pathname)) {
    return { ok: true, auth };
  }

  // Self-scoped audit reads: any signed-in member of staff may read the audit
  // log filtered to their own actions. The My Activity screen (per-role
  // performance dashboard) lives on this — a delivery driver has to see "how
  // many deliveries did I do today" the same way a manager sees "how many
  // orders did I touch". Without this exception, only `manager` and
  // `accountant` (who hold the `audit` read in ROLE_ACCESS) could load the
  // view; every other role would see an empty page despite having actions
  // recorded against them.
  //
  // The scoping is enforced here, not in the handler: the caller MUST pass
  // `actor_id` equal to their own staff_id. A request with no actor_id, or
  // with a different id, falls through to the ordinary role matrix and is
  // refused for any role that does not hold the `audit` read. So this widens
  // nothing — a non-manager still cannot read another person's actions or the
  // system-wide trail.
  if (
    method.toUpperCase() === 'GET' &&
    (pathname === '/api/audit' || pathname === '/api/audit-log')
  ) {
    const requestedActor = url && url.searchParams
      ? url.searchParams.get('actor_id') || url.searchParams.get('actorId')
      : null;
    if (requestedActor && auth.staff_id && String(requestedActor) === String(auth.staff_id)) {
      return { ok: true, auth };
    }
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
