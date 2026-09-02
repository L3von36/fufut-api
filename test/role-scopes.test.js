import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SCOPABLE_SCREENS,
  SCOPABLE_ROLES,
  getRoleScope,
  setRoleScope,
  listRoleScopes,
  screenGrantsForRole,
  isInventoryScoped,
  filterInventoryRows,
  roleMayAccessWithGrants,
  resetGrantCache,
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
          if (/SELECT id, category FROM inventory/.test(sql)) {
            // setRoleScope validates both lists against the live catalogue.
            return { results: inventoryRows.map((r) => ({ id: r.id, category: r.category })) };
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

  it('admits hand-picked items even when their category is not scoped', () => {
    const out = filterInventoryRows(CATALOGUE, { inventory: { enabled: true, itemIds: ['I-beef'] } });
    expect(out.map((r) => r.id)).toEqual(['I-beef']);
  });

  it('unions categories and hand-picked items', () => {
    const out = filterInventoryRows(CATALOGUE, {
      inventory: { enabled: true, categories: ['Coffee & Tea'], itemIds: ['I-beef'] },
    });
    expect(out.map((r) => r.id)).toEqual(['I-beans', 'I-beef']);
  });

  it('returns nothing when the scope has no category list', () => {
    expect(filterInventoryRows(CATALOGUE, { inventory: { enabled: true } })).toEqual([]);
    expect(filterInventoryRows(CATALOGUE, { inventory: { enabled: true, categories: [] } })).toEqual([]);
  });

  it('returns nothing when both lists are empty', () => {
    expect(filterInventoryRows(CATALOGUE, { inventory: { enabled: true, categories: [], itemIds: [] } })).toEqual([]);
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

  it('refuses an unknown screen', async () => {
    const { env } = makeEnv({ inventoryRows: CATALOGUE });
    const res = await setRoleScope(env, 'barista', { payroll: { enabled: true } }, null);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/payroll/);
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

  it('saves a scope of hand-picked items without any category, deduped', async () => {
    const { env } = makeEnv({ inventoryRows: CATALOGUE });
    const res = await setRoleScope(
      env,
      'cleaner',
      { inventory: { enabled: true, categories: [], itemIds: ['I-cup', 'I-cup', ' I-milk '] } },
      null
    );
    expect(res.ok).toBe(true);
    await expect(getRoleScope(env, 'cleaner')).resolves.toEqual({
      inventory: { enabled: true, categories: [], itemIds: ['I-cup', 'I-milk'] },
    });
  });

  it('refuses an unknown item id the same way as an unknown category', async () => {
    const { env } = makeEnv({ inventoryRows: CATALOGUE });
    const res = await setRoleScope(
      env,
      'barista',
      { inventory: { enabled: true, categories: [], itemIds: ['I-ghost'] } },
      null
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/I-ghost/);
  });

  it('drops hand-picked items when the screen is switched off', async () => {
    const { env } = makeEnv({ inventoryRows: CATALOGUE });
    const res = await setRoleScope(
      env,
      'head-waiter',
      { inventory: { enabled: false, categories: ['Packaging'], itemIds: ['I-beef'] }, waste: { enabled: true } },
      null
    );
    expect(res.ok).toBe(true);
    await expect(getRoleScope(env, 'head-waiter')).resolves.toEqual({
      inventory: { enabled: false, categories: [] },
      waste: { enabled: true },
    });
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

  it('saves a multi-screen grant (waste + recipes) beside inventory', async () => {
    const { env } = makeEnv({ inventoryRows: CATALOGUE });
    const res = await setRoleScope(
      env,
      'head-waiter',
      {
        inventory: { enabled: false, categories: [] },
        waste: { enabled: true },
        recipes: { enabled: true },
        orders: { enabled: false },
      },
      null
    );
    expect(res.ok).toBe(true);
    await expect(getRoleScope(env, 'head-waiter')).resolves.toEqual({
      inventory: { enabled: false, categories: [] },
      waste: { enabled: true },
      recipes: { enabled: true },
      orders: { enabled: false },
    });
    await expect(screenGrantsForRole(env, 'head-waiter')).resolves.toEqual(['waste', 'recipes']);
  });

  it('deletes the row when nothing is enabled instead of storing a zombie grant', async () => {
    const { env } = makeEnv({ scopeRows: { 'roleScope.barista': BARISTA_SCOPE }, inventoryRows: CATALOGUE });
    const res = await setRoleScope(env, 'barista', { inventory: { enabled: false, categories: [] } }, null);
    expect(res.ok).toBe(true);
    expect(res.cleared).toBe(true);
    await expect(getRoleScope(env, 'barista')).resolves.toBeNull();
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
    expect(body.screens.map((s) => s.key)).toEqual(SCOPABLE_SCREENS.map((s) => s.key));
    expect(body.screens.find((s) => s.key === 'inventory').scoping).toBe('categories+items');
    expect(body.roles).toContain('barista');
    expect(body.roles).not.toContain('manager');
    expect(body.categories).toContain('Proteins');
    expect(body.scopes[0].role).toBe('barista');
  });

  it('persists a PUT and answers the saved scope', async () => {
    const { env } = makeEnv({ inventoryRows: CATALOGUE });
    const { method, url, request } = req('PUT', '/api/role-scopes/head-chef', {
      screens: { inventory: { enabled: true, categories: ['Proteins'] } },
    });
    const res = await handleRoleScopes(url.pathname, method, url, request, env, { firstName: 'A', lastName: 'F', staff_id: 'S1' });
    expect((await res.json()).ok).toBe(true);
    await expect(getRoleScope(env, 'head-chef')).resolves.toEqual({
      inventory: { enabled: true, categories: ['Proteins'] },
    });
  });

  it('clears a scope on PUT with clear:true', async () => {
    const { env } = makeEnv({ scopeRows: { 'roleScope.barista': BARISTA_SCOPE }, inventoryRows: CATALOGUE });
    const { method, url, request } = req('PUT', '/api/role-scopes/barista', { clear: true });
    const res = await handleRoleScopes(url.pathname, method, url, request, env, null);
    expect((await res.json()).cleared).toBe(true);
    await expect(getRoleScope(env, 'barista')).resolves.toBeNull();
  });

  it('saves a multi-screen grant through the endpoint', async () => {
    const { env } = makeEnv({ inventoryRows: CATALOGUE });
    const { method, url, request } = req('PUT', '/api/role-scopes/cashier', {
      screens: { inventory: { enabled: false, categories: [] }, waste: { enabled: true } },
    });
    const res = await handleRoleScopes(url.pathname, method, url, request, env, null);
    expect((await res.json()).ok).toBe(true);
    await expect(screenGrantsForRole(env, 'cashier')).resolves.toEqual(['waste']);
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

  it('narrows the list to hand-picked items when no category is scoped', async () => {
    const { env } = makeEnv({
      scopeRows: {
        'roleScope.cleaner': JSON.stringify({ inventory: { enabled: true, categories: [], itemIds: ['I-cup'] } }),
      },
      inventoryRows: CATALOGUE,
    });
    const { method, url, request } = req('GET', '/api/inventory');
    const res = await handleInventory(url.pathname, method, url, request, env, { sessionRole: 'cleaner' });
    const body = await res.json();
    expect(body.map((r) => r.id)).toEqual(['I-cup']);
  });

  it('admits a hand-picked item on a direct read even outside the scoped categories', async () => {
    const { env } = makeEnv({
      scopeRows: {
        'roleScope.cleaner': JSON.stringify({
          inventory: { enabled: true, categories: ['Packaging'], itemIds: ['I-beef'] },
        }),
      },
      inventoryRows: CATALOGUE,
    });
    const beef = req('GET', '/api/inventory/I-beef');
    const resBeef = await handleInventory(beef.url.pathname, beef.method, beef.url, beef.request, env, { sessionRole: 'cleaner' });
    expect(resBeef.status).toBe(200);

    const milk = req('GET', '/api/inventory/I-milk');
    const resMilk = await handleInventory(milk.url.pathname, milk.method, milk.url, milk.request, env, { sessionRole: 'cleaner' });
    expect(resMilk.status).toBe(404);
  });

  it('keeps the stock reports a role already owned statically (head-chef) while narrowing its list', async () => {
    const { env } = makeEnv({
      scopeRows: {
        'roleScope.head-chef': JSON.stringify({ inventory: { enabled: true, categories: ['Proteins'] } }),
      },
      inventoryRows: CATALOGUE,
    });
    const list = req('GET', '/api/inventory');
    const resList = await handleInventory(list.url.pathname, list.method, list.url, list.request, env, { sessionRole: 'head-chef' });
    expect((await resList.json()).map((r) => r.id)).toEqual(['I-beef']);

    // The chef's Stock Control screen lives on these routes — a scope must
    // never turn them into a 404 ("reorder" is not an item id) or a 403.
    // (Exemption rule: static inventory WRITE — see the scope block.)
    for (const path of ['/api/inventory/reorder', '/api/inventory/variance', '/api/inventory/capacity']) {
      const { method, url, request } = req('GET', path);
      const res = await handleInventory(url.pathname, method, url, request, env, { sessionRole: 'head-chef' });
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);
    }
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

describe('roleMayAccessWithGrants — widened by manager grants', () => {
  beforeEach(() => {
    // The grant cache is module-level (it survives between requests in a real
    // isolate); these cases each stand up a fresh D1 fake, so wipe it.
    resetGrantCache();
  });

  it('lets a role granted Waste read and log waste', async () => {
    const { env } = makeEnv({ scopeRows: { 'roleScope.head-waiter': JSON.stringify({ waste: { enabled: true } }) } });
    await expect(roleMayAccessWithGrants(env, 'head-waiter', '/api/waste', 'GET')).resolves.toBe(true);
    await expect(roleMayAccessWithGrants(env, 'head-waiter', '/api/waste', 'POST')).resolves.toBe(true);
  });

  it('keeps waste deletion manager-only even for a granted role', async () => {
    const { env } = makeEnv({ scopeRows: { 'roleScope.head-waiter': JSON.stringify({ waste: { enabled: true } }) } });
    await expect(roleMayAccessWithGrants(env, 'head-waiter', '/api/waste/W1', 'DELETE')).resolves.toBe(false);
  });

  it('implies the reads a screen needs: waste names items from inventory, orders filters by tables', async () => {
    const { env } = makeEnv({
      scopeRows: {
        'roleScope.head-waiter': JSON.stringify({ waste: { enabled: true }, orders: { enabled: true } }),
      },
    });
    await expect(roleMayAccessWithGrants(env, 'head-waiter', '/api/inventory', 'GET')).resolves.toBe(true);
    await expect(roleMayAccessWithGrants(env, 'head-waiter', '/api/tables', 'GET')).resolves.toBe(true);
    // …but implied reads are GET-only and grant no tab of their own rights.
    await expect(roleMayAccessWithGrants(env, 'head-waiter', '/api/inventory/I-milk', 'PUT')).resolves.toBe(false);
  });

  it('grants recipes read-only', async () => {
    const { env } = makeEnv({ scopeRows: { 'roleScope.cashier': JSON.stringify({ recipes: { enabled: true } }) } });
    await expect(roleMayAccessWithGrants(env, 'cashier', '/api/recipes', 'GET')).resolves.toBe(true);
    await expect(roleMayAccessWithGrants(env, 'cashier', '/api/recipes/R1', 'PUT')).resolves.toBe(false);
    await expect(roleMayAccessWithGrants(env, 'cashier', '/api/recipes', 'POST')).resolves.toBe(false);
  });

  it('grants orders read-only — the ticket list, not the write path', async () => {
    const { env } = makeEnv({ scopeRows: { 'roleScope.cleaner': JSON.stringify({ orders: { enabled: true } }) } });
    await expect(roleMayAccessWithGrants(env, 'cleaner', '/api/orders', 'GET')).resolves.toBe(true);
    await expect(roleMayAccessWithGrants(env, 'cleaner', '/api/orders', 'POST')).resolves.toBe(false);
    await expect(roleMayAccessWithGrants(env, 'cleaner', '/api/orders/O1', 'PUT')).resolves.toBe(false);
  });

  it('never widens anything for a role with no grant row', async () => {
    const { env } = makeEnv();
    await expect(roleMayAccessWithGrants(env, 'head-waiter', '/api/waste', 'GET')).resolves.toBe(false);
    await expect(roleMayAccessWithGrants(env, 'cleaner', '/api/recipes', 'GET')).resolves.toBe(false);
  });

  it('never reaches a manager-only resource, whatever was granted', async () => {
    const { env } = makeEnv({
      scopeRows: {
        'roleScope.cleaner': JSON.stringify({
          inventory: { enabled: true, categories: ['Cleaning'] },
          waste: { enabled: true },
          recipes: { enabled: true },
          orders: { enabled: true },
        }),
      },
    });
    await expect(roleMayAccessWithGrants(env, 'cleaner', '/api/staff', 'GET')).resolves.toBe(false);
    await expect(roleMayAccessWithGrants(env, 'cleaner', '/api/role-scopes', 'GET')).resolves.toBe(false);
    await expect(roleMayAccessWithGrants(env, 'cleaner', '/api/settings', 'PUT')).resolves.toBe(false);
  });

  it('refreshes within the same env as soon as the scope is saved (cache invalidated)', async () => {
    const { env } = makeEnv({ inventoryRows: CATALOGUE });
    await expect(roleMayAccessWithGrants(env, 'cashier', '/api/waste', 'GET')).resolves.toBe(false);
    await setRoleScope(env, 'cashier', { waste: { enabled: true } }, null);
    await expect(roleMayAccessWithGrants(env, 'cashier', '/api/waste', 'GET')).resolves.toBe(true);
  });
});
