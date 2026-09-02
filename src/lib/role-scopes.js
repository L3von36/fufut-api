/**
 * Role scopes — the data behind the backoffice "Role Access" page.
 *
 * A scope row answers one question per role: "which slice of a shared screen
 * does this role actually need?" V1 covers exactly one screen, inventory,
 * because that is the concrete need: the barista should see the bar's stock
 * (beans, milk, cups) and not the kitchen's (beef, teff, injera), while the
 * chefs keep the whole catalogue.
 *
 * Storage is the existing `settings` key/value table (values are JSON), keyed
 * `roleScope.<role>` — one row per role, upserted by the manager. No migration,
 * because the table was built for exactly this shape of configuration.
 *
 * What a scope does and does not do:
 *   - enabled:true  → the role keeps the Inventory screen and every inventory
 *     LIST read is filtered to the chosen categories (the Waste form's item
 *     picker reads the same list, so it narrows with it — logging spilled milk
 *     should not offer beef).
 *   - enabled:false / no row → nothing changes: the static role matrix still
 *     decides what the role may reach, and the list comes back unfiltered.
 *   - The scope NEVER widens access. It can only narrow what an already
 *     granted read returns, and it never turns a read into a write.
 *   - The manager role is never scoped — the owner sees everything, and the
 *     Role Access page refuses to create a manager row.
 */

import { d1Query, d1Run, now } from './db.js';
import { writeAudit } from './audit.js';
import { actorName } from '../auth.js';

/** Screens a manager may grant/scope from the Role Access page. */
export const SCOPABLE_SCREENS = ['inventory'];

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
 * Screen grants for the login / auth-me responses: the extra views the POS
 * should show for this role beyond its static ROLE_PERMISSIONS. Fails soft —
 * a settings read error means no grants, never a broken sign-in.
 */
export async function screenGrantsForRole(env, role) {
  try {
    const scope = await getRoleScope(env, role);
    if (!scope || !scope.inventory || !scope.inventory.enabled) return [];
    return ['inventory'];
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
 * Validate and persist one role's scope. Categories are checked against the
 * live catalogue so a typo can never silently hide everything.
 */
export async function setRoleScope(env, role, scope, auth) {
  const key = String(role || '').toLowerCase().replace(/\s+/g, '-');
  if (!SCOPABLE_ROLES.includes(key)) {
    return { ok: false, error: `Unknown or non-scopable role: ${role}` };
  }
  if (scope === null || scope === undefined) {
    await d1Run(env, 'DELETE FROM settings WHERE key = ?', [scopeKey(key)]);
    await writeAudit(env, auth, {
      action: 'delete',
      entity: 'role-scope',
      entityId: key,
      before: await getRoleScope(env, key),
      after: null,
    });
    return { ok: true, cleared: true };
  }

  const inv = scope.inventory;
  if (!inv || typeof inv !== 'object') {
    return { ok: false, error: 'scope.inventory object is required' };
  }
  const enabled = !!inv.enabled;
  let categories = Array.isArray(inv.categories) ? [...new Set(inv.categories.map((c) => String(c || '').trim()).filter(Boolean))] : [];
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

  const value = JSON.stringify({ inventory: { enabled, categories } });
  await d1Run(
    env,
    "INSERT INTO settings (key, value, category, label, updated_at, updated_by) VALUES (?, ?, 'operations', ?, ?, ?) " +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
    [scopeKey(key), value, 'Role scope: which stock this role sees', now(), auth ? actorName(auth) : null]
  );
  await writeAudit(env, auth, {
    action: 'update',
    entity: 'role-scope',
    entityId: key,
    before: await getRoleScope(env, key),
    after: { inventory: { enabled, categories } },
  });
  return { ok: true, scope: { inventory: { enabled, categories } } };
}
