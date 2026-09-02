/**
 * Role Access endpoints — the manager's permission-granter.
 *
 * GET /api/role-scopes       → every saved scope, plus the live category
 *                              catalogue so the page can render real checkboxes.
 * PUT /api/role-scopes/:role → upsert (or clear, with a null body) one role's
 *                              scope. Manager-only, enforced by MANAGER_ONLY
 *                              in auth.js, and audited like every write.
 *
 * The endpoints live outside the generic resource handler on purpose: scopes
 * are configuration, not rows, and the PUT validates categories against the
 * live inventory catalogue before saving.
 */

import { d1Query, json, readBody } from '../lib/db.js';
import {
  SCOPABLE_SCREENS,
  SCOPABLE_ROLES,
  listRoleScopes,
  setRoleScope,
} from '../lib/role-scopes.js';

export async function handleRoleScopes(pathname, method, url, request, env, auth) {
  if (!pathname.startsWith('/api/role-scopes')) return null;
  const m = method.toUpperCase();
  const sub = pathname.replace(/^\/api\/role-scopes/, '');

  if (m === 'GET' && (sub === '' || sub === '/')) {
    // The catalogue comes straight off the live inventory table: the page's
    // checkboxes must offer the categories that actually exist today.
    const [{ results: invRows }, scopes] = await Promise.all([
      d1Query(env, 'SELECT DISTINCT category FROM inventory WHERE category IS NOT NULL ORDER BY category'),
      listRoleScopes(env),
    ]);
    return json({
      ok: true,
      screens: SCOPABLE_SCREENS,
      roles: SCOPABLE_ROLES,
      categories: (invRows || []).map((r) => r.category),
      scopes,
    });
  }

  const put = sub.match(/^\/([^/]+)$/);
  if (m === 'PUT' && put) {
    const data = await readBody(request);
    if (data === undefined || data === null || typeof data !== 'object') {
      return json({ ok: false, error: 'JSON body required ({inventory:{enabled,categories}} or {inventory:null} to clear)' }, 400);
    }
    // {inventory: null} or {} clears the role back to its static defaults.
    const res = await setRoleScope(env, decodeURIComponent(put[1]), data.inventory ? data : null, auth);
    if (!res.ok) return json(res, 400);
    return json(res);
  }

  return null;
}
