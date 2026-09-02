/**
 * Role scopes — the data behind the backoffice "Role Access" page.
 *
 * A scope row answers one question per role: "which extra screens does this
 * role need, and for inventory — which slice of the catalogue?" The barista
 * sees the bar's stock (beans, milk, cups) and not the kitchen's (beef, teff,
 * injera); a head-waiter can be handed the Waste Log or the Recipes without
 * touching their other screens.
 *
 * Storage is the existing `settings` key/value table (values are JSON), keyed
 * `roleScope.<role>` — one row per role, upserted by the manager. No migration,
 * because the table was built for exactly this shape of configuration. The
 * value is `{ <screenKey>: { enabled: bool, categories?: [..] } }` — the
 * categories list is inventory's alone.
 *
 * What a grant does and does not do:
 *   - enabled screen  → the POS shows that tab (login/auth-me carry
 *     `screenGrants`), and the API widens the role matrix for THAT resource
 *     only, only for the methods the screen needs. Grants are read-shaped by
 *     design; the one write is Waste's POST, because logging spilled milk is
 *     the entire point of that screen.
 *   - implied reads   → a screen's own data needs: the Waste form names items
 *     from inventory, the Orders screen filters by tables. Implies are GET-only
 *     and never become nav tabs.
 *   - inventory scope → when the Inventory screen itself is enabled with
 *     categories, every inventory LIST read narrows to them (also for implied
 *     callers, so the waste picker narrows with it). Analysis reports —
 *     variance, reorder, capacity — stay behind the scope.
 *   - The manager role is never scoped or granted — the owner sees everything,
 *     and the Role Access page refuses to create a manager row.
 */

import { d1Query, d1Run, now } from './db.js';
import { writeAudit } from './audit.js';
// Same shape as audit.js → auth.js: role-scopes only calls auth's helpers
// from inside function bodies, so the cycle is safe under ESM live bindings.
import { actorName, roleMayAccess, resourceForPath } from '../auth.js';

/**
 * Screens a manager may grant from the Role Access page — the single source
 * of truth for the page's sections, the API widening, and the grants the POS
 * is told about at sign-in.
 */
export const SCOPABLE_SCREENS = [
  {
    key: 'inventory',
    label: 'Inventory',
    blurb: 'Stock levels and the item list. Scope it to the categories this role actually touches.',
    methods: ['GET'],
    impliesRead: [],
    scoping: 'categories',
  },
  {
    key: 'waste',
    label: 'Waste Log',
    blurb: 'Recording what was thrown away (read + log). Deleting entries stays with the manager.',
    methods: ['GET', 'POST'],
    impliesRead: ['inventory'],
    scoping: 'none',
  },
  {
    key: 'recipes',
    label: 'Recipes',
    blurb: 'Read-only lookup — what goes in a dish and what it costs to make.',
    methods: ['GET'],
    impliesRead: ['inventory'],
    scoping: 'none',
  },
  {
    key: 'orders',
    label: 'Orders',
    blurb: 'The full ticket list, whole orders rather than routed lines. Read-only.',
    methods: ['GET'],
    impliesRead: ['tables'],
    scoping: 'none',
  },
];

const SCREEN_KEYS = new Set(SCOPABLE_SCREENS.map((s) => s.key));

/** Roles that may be given a scoped screen. The manager sees everything. */
export const SCOPABLE_ROLES = [
  'head-chef',
  'assistant-chef',
  'barista',
  'head-waiter',
  'cashier',
  'delivery-staff',
  'cleaner',
  'accountant',
];

function scopeKey(role) {
  return 'roleScope.' + String(role || '').toLowerCase().replace(/\s+/g, '-');
}

/** Read one role's scope row. Returns null when none was ever saved. */
export async function getRoleScope(env, role) {
  const key = scopeKey(role);
  const { results } = await d1Query(env, 'SELECT value FROM settings WHERE key = ?', [key]);
  if (!results || !results.length) return null;
  try {
    const parsed = JSON.parse(results[0].value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null; // a corrupt row must not take the inventory list down
  }
}

/**
 * Enabled screen keys for a role — the nav tabs the POS may draw. Fails soft:
 * a settings read error means no grants, never a broken sign-in.
 */
export async function screenGrantsForRole(env, role) {
  try {
    const scope = await getRoleScope(env, role);
    if (!scope) return [];
    return SCOPABLE_SCREENS.filter((s) => scope[s.key] && scope[s.key].enabled).map((s) => s.key);
  } catch {
    return [];
  }
}

/**
 * Is this caller's inventory view scoped? The manager is exempt by design and
 * the check fails closed towards "not scoped" — an absent or corrupt row must
 * not silently empty the kitchen's stock screen.
 */
export function isInventoryScoped(role, scope) {
  const key = String(role || '').toLowerCase().replace(/\s+/g, '-');
  if (!key || key === 'manager') return false;
  return !!(scope && scope.inventory && scope.inventory.enabled);
}

/** Narrow a list of inventory rows to the scoped categories. */
export function filterInventoryRows(rows, scope) {
  const cats = scope && scope.inventory && scope.inventory.categories;
  if (!Array.isArray(cats)) return [];
  const allow = new Set(cats);
  return (rows || []).filter((r) => allow.has(r && r.category));
}

/** Every scope row saved so far, for the Role Access page's overview. */
export async function listRoleScopes(env) {
  const { results } = await d1Query(
    env,
    "SELECT key, value, updated_at, updated_by FROM settings WHERE key LIKE 'roleScope.%'"
  );
  return (results || []).map((r) => {
    let scope = null;
    try {
      scope = JSON.parse(r.value);
    } catch { /* leave null; the page shows it as unset */ }
    return { role: r.key.replace('roleScope.', ''), scope, updatedAt: r.updated_at, updatedBy: r.updated_by };
  });
}

/**
 * Validate and persist one role's screen set. The page sends the COMPLETE
 * desired state for every screen it shows; `null` scope clears the row.
 * Inventory keeps its category validation so a typo can never silently hide
 * everything; every other screen is just an on flag. A row where nothing is
 * enabled is deleted rather than left behind as a zombie grant.
 */
export async function setRoleScope(env, role, screens, auth) {
  const key = String(role || '').toLowerCase().replace(/\s+/g, '-');
  if (!SCOPABLE_ROLES.includes(key)) {
    return { ok: false, error: `Unknown or non-grantable role: ${role}` };
  }
  if (screens === null || screens === undefined) {
    await d1Run(env, 'DELETE FROM settings WHERE key = ?', [scopeKey(key)]);
    invalidateGrantCache(key);
    await writeAudit(env, auth, {
      action: 'delete',
      entity: 'role-scope',
      entityId: key,
      before: await getRoleScope(env, key),
      after: null,
    });
    return { ok: true, cleared: true };
  }
  if (typeof screens !== 'object' || Array.isArray(screens)) {
    return { ok: false, error: 'screens object is required' };
  }

  const value = {};
  for (const [screenKey, cfg] of Object.entries(screens)) {
    if (!SCREEN_KEYS.has(screenKey)) {
      return { ok: false, error: `Unknown screen: ${screenKey}` };
    }
    const def = SCOPABLE_SCREENS.find((s) => s.key === screenKey);
    if (!cfg || typeof cfg !== 'object') {
      return { ok: false, error: `${def.label} needs an {enabled} object` };
    }
    const enabled = !!cfg.enabled;
    if (screenKey === 'inventory') {
      let categories = Array.isArray(cfg.categories)
        ? [...new Set(cfg.categories.map((c) => String(c || '').trim()).filter(Boolean))]
        : [];
      if (enabled) {
        const { results } = await d1Query(env, 'SELECT DISTINCT category FROM inventory WHERE category IS NOT NULL');
        const live = new Set((results || []).map((r) => r.category));
        const unknown = categories.filter((c) => !live.has(c));
        if (unknown.length) {
          return { ok: false, error: `Unknown inventory categories: ${unknown.join(', ')}` };
        }
        if (!categories.length) {
          return { ok: false, error: 'Pick at least one category, or turn inventory access off.' };
        }
      } else {
        categories = [];
      }
      value.inventory = { enabled, categories };
    } else {
      value[screenKey] = { enabled };
    }
  }

  // Nothing enabled — a row of offs is the same as no row at all, so remove
  // any old one instead of storing a grant that grants nothing.
  const anyEnabled = SCOPABLE_SCREENS.some((s) => value[s.key] && value[s.key].enabled);
  const before = await getRoleScope(env, key);
  if (!anyEnabled) {
    await d1Run(env, 'DELETE FROM settings WHERE key = ?', [scopeKey(key)]);
    invalidateGrantCache(key);
    await writeAudit(env, auth, {
      action: 'delete',
      entity: 'role-scope',
      entityId: key,
      before,
      after: null,
    });
    return { ok: true, cleared: true };
  }

  await d1Run(
    env,
    "INSERT INTO settings (key, value, category, label, updated_at, updated_by) VALUES (?, ?, 'operations', ?, ?, ?) " +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
    [scopeKey(key), JSON.stringify(value), 'Role scope: which screens this role was granted', now(), auth ? actorName(auth) : null]
  );
  invalidateGrantCache(key);
  await writeAudit(env, auth, {
    action: 'update',
    entity: 'role-scope',
    entityId: key,
    before,
    after: value,
  });
  return { ok: true, scope: value };
}

/**
 * The widened-access check behind `roleMayAccessWithGrants`: the static role
 * matrix stays the authority; a grant only ever ADDS a listed resource for the
 * listed methods of that one screen. Nothing here can reach a manager-only
 * route — staff, role-scopes, settings, payroll are resources no screen
 * configures.
 */

// Grants are read from D1 on every authorized request otherwise; a short
// in-memory cache keeps the hot path at zero extra queries while still making
// a backoffice save land on every worker isolate within a minute.
const GRANT_CACHE_TTL_MS = 60_000;
const grantCache = new Map(); // role -> { at, screens: string[] }

function invalidateGrantCache(key) {
  grantCache.delete(String(key || '').toLowerCase().replace(/\s+/g, '-'));
}

/**
 * Test/ops hook: drop every cached grant. In production a role's grants only
 * change through setRoleScope (which invalidates its own key); tests reuse the
 * module across fresh D1 fakes, so they need the slate wiped between cases.
 */
export function resetGrantCache() {
  grantCache.clear();
}

async function grantedScreens(env, role) {
  const key = String(role || '').toLowerCase().replace(/\s+/g, '-');
  if (!key || key === 'manager') return [];
  const hit = grantCache.get(key);
  if (hit && Date.now() - hit.at < GRANT_CACHE_TTL_MS) return hit.screens;
  // Fail soft, same rule as screenGrantsForRole: grants only ever WIDEN the
  // static matrix, so an unreadable settings store must degrade to "no
  // grants" — never turn into a refusal for roles the matrix already allows.
  let screens = [];
  try {
    const scope = await getRoleScope(env, key);
    screens = scope
      ? SCOPABLE_SCREENS.filter((s) => scope[s.key] && scope[s.key].enabled).map((s) => s.key)
      : [];
  } catch {
    screens = [];
  }
  grantCache.set(key, { at: Date.now(), screens });
  return screens;
}

/**
 * The role matrix, then the manager's grants. Called from authorize() in
 * place of the bare roleMayAccess check.
 */
export async function roleMayAccessWithGrants(env, role, pathname, method) {
  if (roleMayAccess(role, pathname, method)) return true;

  const resource = resourceForPath(pathname);
  if (!resource) return false;
  const m = String(method || '').toUpperCase();

  for (const screenKey of await grantedScreens(env, role)) {
    const def = SCOPABLE_SCREENS.find((s) => s.key === screenKey);
    if (!def) continue;
    if (def.methods.includes(m) && def.key === resource) return true;
    if (m === 'GET' && def.impliesRead.includes(resource)) return true;
  }
  return false;
}
