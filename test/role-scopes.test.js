import { describe, it, expect, vi } from 'vitest';
import {
  SCOPABLE_SCREENS,
  SCOPABLE_ROLES,
  getRoleScope,
  setRoleScope,
  listRoleScopes,
  screenGrantsForRole,
  isInventoryScoped,
  filterInventoryRows,
} from '../src/lib/role-scopes.js';
import { handleRoleScopes } from '../src/handlers/role-scopes.js';
import { handleInventory } from '../src/handlers/inventory.js';

/**
 * Role scopes: the data behind the backoffice Role Access page.
 *
 * The manager grants a role (first real case: the barista) a slice of the
 * inventory catalogue — drink stock for the bar, food stock for the kitchen —
 * and the API narrows every inventory read to it. The tests care about the
 * failure modes a coffee shop would actually hit: a typo'd category silently
 * emptying the bar's stock screen, the manager's own view getting narrowed,
 * a scoped role reading the supplier-cost reports the scope was meant to keep
 * away, and a corrupt settings row taking the list down.
 *
 * D1 fake keyed on the shape of the SQL, matching orders-transfer.test.js.
 */
function makeEnv({ scopeRows = {}, inventoryRows = [] } = {}) {
  const settings = new Map(Object.entries(scopeRows));
  const run = vi.fn().mockResolvedValue({ meta: { changes: 1 }, results: [] });
  const prepare = vi.fn(function (sql) {
    return {
      bind: (...params) => ({
        all: async () => {
          if (/FROM settings WHERE key = \?/.test(sql)) {
            const key = String(params[0]);
            return settings.has(key)
              ? { results: [{ value: settings.get(key) }] }
              : { results: [] };
          }
          if (/FROM settings WHERE key LIKE 'roleScope.%'/.test(sql)) {
            return {
              results: [...settings.entries()].map(([key, value]) => ({
                key,
                value,
                updated_at: '2026-09-02T00:00:00Z',
                updated_by: 'Amanuel Fekadu',
              })),
            };
          }
          if (/SELECT DISTINCT category FROM inventory/.test(sql)) {
            const live = [...new Set(inventoryRows.map((r) => r.category).filter(Boolean))];
            return { results: live.map((category) => ({ category })) };
          }
          if (/SELECT \* FROM inventory WHERE id = \?/.test(sql)) {
            return { results: inventoryRows.filter((r) => r.id === String(params[0])) };
          }
          if (/SELECT \* FROM inventory/.test(sql)) {
            return { results: inventoryRows };
          }
          return { results: [] };
        },
        run: async () => {
          if (/INSERT INTO settings/.test(sql)) {
            settings.set(String(params[0]), String(params[1]));
          }
          if (/DELETE FROM settings/.test(sql)) {
            settings.delete(String(params[0]));
          }
          return { meta: { changes: 1 } };
        },
      }),
    };
  });
  return { env: { DB: { prepare, batch: vi.fn().mockResolvedValue([]) } }, run, settings };
}

const BEANS = { id: 'I-beans', name: 'Coffee beans', category: 'Coffee & Tea', stock: 20 };
const MILK = { id: 'I-milk', name: 'Milk', category: 'Dairy & Eggs', stock: 80 };
const CUP = { id: 'I-cup', name: 'Coffee cup', category: 'Packaging', stock: 900 };
const BEEF = { id: 'I-beef', name: 'Beef', category: 'Proteins', stock: 100 };
const CATALOGUE = [BEANS, MILK, CUP, BEEF];

const BARISTA_SCOPE = JSON.stringify({
  inventory: { enabled: true, categories: ['Coffee & Tea', 'Dairy & Eggs', 'Packaging'] },
});

function req(method, pathname, body) {
  const url = new URL('https://pos.fufutcoffee.com' + pathname);
  return {
    method,
    url,
    request: new Request(url.toString(), {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    }),
  };
}

describe('isInventoryScoped', () => {
  it('scopes a role with an enabled inventory scope', () => {
    expect(isInventoryScoped('barista', JSON.parse(BARISTA_SCOPE))).toBe(true);
  });

  it('never scopes the manager, even with a row', () => {
    expect(isInventoryScoped('manager', JSON.parse(BARISTA_SCOPE))).toBe(false);
  });

  it('treats a disabled scope or a missing row as unscoped', () => {
    expect(isInventoryScoped('barista', { inventory: { enabled: false, categories: [] } })).toBe(false);
    expect(isInventoryScoped('barista', null)).toBe(false);
    expect(isInventoryScoped('barista', undefined)).toBe(false);
  });

  it('fails closed towards unscoped on a corrupt row', () => {
    // A broken settings row must not silently empty the kitchen's stock screen.
    expect(isInventoryScoped('barista', 'not-an-object')).toBe(false);
  });
});

describe('filterInventoryRows', () => {
  it('keeps only the scoped categories', () => {
    const out = filterInventoryRows(CATALOGUE, JSON.parse(BARISTA_SCOPE));
    expect(out.map((r) => r.id)).toEqual(['I-beans', 'I-milk', 'I-cup']);
  });

  it('returns nothing when the scope has no category list', () => {
    expect(filterInventoryRows(CATALOGUE, { inventory: { enabled: true } })).toEqual([]);
    expect(filterInventoryRows(CATALOGUE, { inventory: { enabled: true, categories: [] } })).toEqual([]);
  });
});

describe('screenGrantsForRole', () => {
  it('grants inventory to a role with an enabled scope', async () => {
    const { env } = makeEnv({ scopeRows: { 'roleScope.barista': BARISTA_SCOPE } });
    await expect(screenGrantsForRole(env, 'barista')).resolves.toEqual(['inventory']);
  });

  it('grants nothing without a row', async () => {
    const { env } = makeEnv();
    await expect(screenGrantsForRole(env, 'barista')).resolves.toEqual([]);
  });

  it('grants nothing when the stored JSON is corrupt', async () => {
    const { env } = makeEnv({ scopeRows: { 'roleScope.barista': '{not json' } });
    await expect(screenGrantsForRole(env, 'barista')).resolves.toEqual([]);
  });
});

describe('setRoleScope', () => {
  it('refuses a role outside the scopable list', async () => {
    const { env } = makeEnv();
    const res = await setRoleScope(env, 'someone-else', { inventory: { enabled: true, categories: ['Packaging'] } }, null);
    expect(res.ok).toBe(false);
  });

  it('refuses to scope the manager', async () => {
    const { env } = makeEnv();
    const res = await setRoleScope(env, 'manager', { inventory: { enabled: true, categories: ['Packaging'] } }, null);
    expect(res.ok).toBe(false);
  });

  it('refuses an unknown category so a typo cannot silently hide everything', async () => {
    const { env } = makeEnv({ inventoryRows: CATALOGUE });
    const res = await setRoleScope(env, 'barista', { inventory: { enabled: true, categories: ['Cofee & Tea'] } }, null);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Cofee & Tea/);
  });

  it('refuses an enabled scope with no categories', async () => {
    const { env } = makeEnv({ inventoryRows: CATALOGUE });
    const res = await setRoleScope(env, 'barista', { inventory: { enabled: true, categories: [] } }, null);
    expect(res.ok).toBe(false);
  });

  it('saves a valid scope and reports it back', async () => {
    const { env } = makeEnv({ inventoryRows: CATALOGUE });
    const res = await setRoleScope(
      env,
      'barista',
      { inventory: { enabled: true, categories: ['Coffee & Tea', 'Packaging'] } },
      { firstName: 'Amanuel', lastName: 'Fekadu', staff_id: 'S1' }
    );
    expect(res.ok).toBe(true);
    await expect(getRoleScope(env, 'barista')).resolves.toEqual({
      inventory: { enabled: true, categories: ['Coffee & Tea', 'Packaging'] },
    });
  });

  it('clears a scope back to the role’s static defaults', async () => {
    const { env } = makeEnv({
      scopeRows: { 'roleScope.barista': BARISTA_SCOPE },
      inventoryRows: CATALOGUE,
    });
    const res = await setRoleScope(env, 'barista', null, null);
    expect(res.ok).toBe(true);
    expect(res.cleared).toBe(true);
    await expect(getRoleScope(env, 'barista')).resolves.toBeNull();
  });
});

describe('listRoleScopes', () => {
  it('lists saved scopes keyed by role', async () => {
    const { env } = makeEnv({ scopeRows: { 'roleScope.barista': BARISTA_SCOPE } });
    const scopes = await listRoleScopes(env);
    expect(scopes).toHaveLength(1);
    expect(scopes[0].role).toBe('barista');
    expect(scopes[0].scope.inventory.enabled).toBe(true);
  });
});

describe('handleRoleScopes', () => {
  it('serves the catalogue the page needs: screens, roles, categories, scopes', async () => {
    const { env } = makeEnv({ scopeRows: { 'roleScope.barista': BARISTA_SCOPE }, inventoryRows: CATALOGUE });
    const { method, url, request } = req('GET', '/api/role-scopes');
    const res = await handleRoleScopes(url.pathname, method, url, request, env, null);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.screens).toEqual(SCOPABLE_SCREENS);
    expect(body.roles).toContain('barista');
    expect(body.roles).not.toContain('manager');
    expect(body.categories).toContain('Proteins');
    expect(body.scopes[0].role).toBe('barista');
  });

  it('persists a PUT and answers the saved scope', async () => {
    const { env } = makeEnv({ inventoryRows: CATALOGUE });
    const { method, url, request } = req('PUT', '/api/role-scopes/head-chef', {
      inventory: { enabled: true, categories: ['Proteins'] },
    });
    const res = await handleRoleScopes(url.pathname, method, url, request, env, { firstName: 'A', lastName: 'F', staff_id: 'S1' });
    expect((await res.json()).ok).toBe(true);
    await expect(getRoleScope(env, 'head-chef')).resolves.toEqual({
      inventory: { enabled: true, categories: ['Proteins'] },
    });
  });

  it('clears a scope on PUT with a null inventory', async () => {
    const { env } = makeEnv({ scopeRows: { 'roleScope.barista': BARISTA_SCOPE }, inventoryRows: CATALOGUE });
    const { method, url, request } = req('PUT', '/api/role-scopes/barista', { inventory: null });
    const res = await handleRoleScopes(url.pathname, method, url, request, env, null);
    expect((await res.json()).cleared).toBe(true);
    await expect(getRoleScope(env, 'barista')).resolves.toBeNull();
  });
});

describe('scoped inventory reads in handleInventory', () => {
  it('narrows the list to the role’s categories and keeps the bare-array shape', async () => {
    const { env } = makeEnv({ scopeRows: { 'roleScope.barista': BARISTA_SCOPE }, inventoryRows: CATALOGUE });
    const { method, url, request } = req('GET', '/api/inventory');
    const res = await handleInventory(url.pathname, method, url, request, env, { sessionRole: 'barista' });
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.map((r) => r.id)).toEqual(['I-beans', 'I-milk', 'I-cup']);
  });

  it('refuses the stock reports a scope exists to keep away', async () => {
    const { env } = makeEnv({ scopeRows: { 'roleScope.barista': BARISTA_SCOPE }, inventoryRows: CATALOGUE });
    for (const path of ['/api/inventory/reorder', '/api/inventory/variance', '/api/inventory/capacity', '/api/inventory/expiring']) {
      const { method, url, request } = req('GET', path);
      const res = await handleInventory(url.pathname, method, url, request, env, { sessionRole: 'barista' });
      expect(res.status).toBe(403);
    }
    // Per-item ledgers quote the whole movement history: same rule.
    const { method, url, request } = req('GET', '/api/inventory/I-beef/movements');
    const res = await handleInventory(url.pathname, method, url, request, env, { sessionRole: 'barista' });
    expect(res.status).toBe(403);
  });

  it('hides an out-of-scope item behind a 404 on a direct read', async () => {
    const { env } = makeEnv({ scopeRows: { 'roleScope.barista': BARISTA_SCOPE }, inventoryRows: CATALOGUE });
    const out = req('GET', '/api/inventory/I-beef');
    const resOut = await handleInventory(out.url.pathname, out.method, out.url, out.request, env, { sessionRole: 'barista' });
    expect(resOut.status).toBe(404);

    const inScope = req('GET', '/api/inventory/I-beans');
    const resIn = await handleInventory(inScope.url.pathname, inScope.method, inScope.url, inScope.request, env, { sessionRole: 'barista' });
    expect((await resIn.json()).id).toBe('I-beans');
  });

  it('leaves everything alone for an unscoped role and for the manager', async () => {
    const unscoped = makeEnv({ inventoryRows: CATALOGUE });
    const a = req('GET', '/api/inventory');
    await expect(
      handleInventory(a.url.pathname, a.method, a.url, a.request, unscoped.env, { sessionRole: 'barista' })
    ).resolves.toBeNull();

    const scopedRow = makeEnv({ scopeRows: { 'roleScope.barista': BARISTA_SCOPE }, inventoryRows: CATALOGUE });
    const b = req('GET', '/api/inventory/reorder');
    const resB = await handleInventory(b.url.pathname, b.method, b.url, b.request, scopedRow.env, { sessionRole: 'manager' });
    // The manager keeps the report: scoping narrows other roles, never the owner.
    expect(resB.status).toBe(200);
    expect((await resB.json()).ok).toBe(true);
  });
});
