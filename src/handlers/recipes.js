/**
 * Recipes / BOM.
 *
 * ── Versioning is the whole design ──────────────────────────────────────────
 *
 * A recipe row *is* a version. Changing a coffee from 18 g to 20 g archives the
 * current row and inserts a new one; it never updates the lines in place. §25
 * requires that historical sales keep the recipe they were actually made with,
 * and in-place editing would silently rewrite every food-cost and margin figure
 * the business has ever produced — last month's reports would change overnight
 * with nothing to show why.
 *
 * The snapshot that makes this real is written elsewhere: lib/ledger.js stamps
 * `order_items.recipe_id` and the costs at the moment of consumption, so a
 * report reads what was true then rather than recomputing from what is true now.
 *
 * A partial unique index enforces one active recipe per menu item, so "which
 * recipe did we consume" is never ambiguous at the point it has to be recorded.
 */

import { d1Query, d1Run, json, readBody } from '../lib/db.js';
import { writeAudit } from '../lib/audit.js';
import { actorName } from '../auth.js';
import { isKnownUnit, areCompatible, unitCatalogue } from '../lib/units.js';
import { recipeCost, menuItemMargin, productionCapacity } from '../lib/inventory.js';

async function loadInventoryMap(env) {
  const { results } = await d1Query(env, 'SELECT * FROM inventory');
  return new Map((results || []).map((i) => [String(i.id), i]));
}

async function withLines(env, recipe) {
  const { results } = await d1Query(
    env,
    'SELECT * FROM recipe_items WHERE recipe_id = ? ORDER BY sort_order, id',
    [recipe.id]
  );
  return { ...recipe, lines: results || [] };
}

/**
 * Validate BOM lines before anything is written.
 *
 * Units are checked here, at save time, rather than at the point of sale. A
 * recipe saying "5 ml of sugar" against sugar stocked in kg is a mistake the
 * chef can fix now; discovering it when the order lands means the sale posts no
 * consumption and the shelf silently drifts.
 */
async function validateLines(env, lines) {
  const errors = [];
  if (!Array.isArray(lines) || !lines.length) {
    return { errors: ['A recipe needs at least one ingredient'], clean: [] };
  }

  const inventory = await loadInventoryMap(env);
  const clean = [];
  const seen = new Set();

  lines.forEach((line, i) => {
    const label = `Line ${i + 1}`;
    const invId = String(line.inventoryId || line.inventory_id || '');
    const item = inventory.get(invId);
    if (!item) { errors.push(`${label}: ingredient not found`); return; }

    const qty = Number(line.qty);
    if (!Number.isFinite(qty) || qty <= 0) {
      errors.push(`${label} (${item.name}): quantity must be greater than zero`);
      return;
    }

    const unit = String(line.unit || item.unit);
    if (!isKnownUnit(unit)) { errors.push(`${label} (${item.name}): unknown unit "${unit}"`); return; }
    if (!areCompatible(unit, item.unit)) {
      errors.push(
        `${label} (${item.name}): recipe is in ${unit} but the item is stocked in ${item.unit}, which measures something different`
      );
      return;
    }

    // The same ingredient twice would double-consume and make the BOM
    // impossible to read. Merged rather than refused, which is what the chef
    // meant.
    if (seen.has(invId)) {
      const existing = clean.find((c) => c.inventory_id === invId);
      if (existing && existing.unit === unit) { existing.qty += qty; return; }
      errors.push(`${label} (${item.name}): listed twice in different units`);
      return;
    }
    seen.add(invId);

    clean.push({
      inventory_id: invId,
      qty,
      unit,
      is_packaging: line.isPackaging || line.is_packaging || item.is_packaging ? 1 : 0,
      waste_pct: Number(line.wastePct || line.waste_pct) || 0,
      optional: line.optional ? 1 : 0,
      sort_order: i,
      notes: line.notes || null,
    });
  });

  return { errors, clean };
}

/** Columns on recipes, so `variant` can be written only once migration 009 is in. */
let RECIPE_COLUMNS = null;
async function recipeColumns(env) {
  if (RECIPE_COLUMNS) return RECIPE_COLUMNS;
  const { results } = await d1Query(env, 'PRAGMA table_info(recipes)');
  RECIPE_COLUMNS = (results || []).map((c) => c.name);
  return RECIPE_COLUMNS;
}

async function insertRecipe(env, auth, { menuItemId, name, variant, version, yieldQty, yieldUnit, notes, lines }) {
  const id = 'RC' + crypto.randomUUID().slice(0, 10);
  const nowIso = new Date().toISOString();
  const hasVariant = (await recipeColumns(env)).includes('variant');

  await d1Run(
    env,
    `INSERT INTO recipes
       (id, menu_item_id, name, version, status, yield_qty, yield_unit, notes,
        effective_from, created_by, created_by_name, created_at${hasVariant ? ', variant' : ''})
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?${hasVariant ? ', ?' : ''})`,
    [
      id,
      menuItemId || null,
      name,
      version,
      Number(yieldQty) || 1,
      yieldUnit || 'serving',
      notes || null,
      nowIso,
      (auth && auth.staff_id) || null,
      auth ? actorName(auth) : null,
      nowIso,
      ...(hasVariant ? [variant || null] : []),
    ]
  );

  if (lines.length) {
    await env.DB.batch(
      lines.map((l) =>
        env.DB.prepare(
          `INSERT INTO recipe_items
             (id, recipe_id, inventory_id, qty, unit, is_packaging, waste_pct, optional, sort_order, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          'RI' + crypto.randomUUID().slice(0, 10),
          id,
          l.inventory_id,
          l.qty,
          l.unit,
          l.is_packaging,
          l.waste_pct,
          l.optional,
          l.sort_order,
          l.notes
        )
      )
    );
  }

  return id;
}

/** POST /api/recipes — create, or supersede the menu item's current recipe. */
async function createRecipe(request, env, auth) {
  const data = await readBody(request);
  if (!data) return json({ ok: false, error: 'Invalid JSON body' }, 400);

  const menuItemId = data.menuItemId || data.menu_item_id || null;
  const name = String(data.name || '').trim();
  if (!name) return json({ ok: false, error: 'A recipe needs a name' }, 400);

  const { errors, clean } = await validateLines(env, data.lines || data.items);
  if (errors.length) return json({ ok: false, error: 'Recipe is not valid', problems: errors }, 400);

  // Supersede rather than overwrite, and only within the same variant: saving a
  // Large must not archive the Small. Before variants existed there was one
  // active recipe per dish, and archiving it was unambiguous; now the pair
  // (dish, variant) is what a new version replaces.
  const variant = (data.variant || '').trim() || null;
  let version = 1;
  let supersededId = null;
  if (menuItemId) {
    const hasVariant = (await recipeColumns(env)).includes('variant');
    const { results } = await d1Query(
      env,
      hasVariant
        ? "SELECT * FROM recipes WHERE menu_item_id = ? AND status = 'active' AND COALESCE(variant,'') = ? LIMIT 1"
        : "SELECT * FROM recipes WHERE menu_item_id = ? AND status = 'active' LIMIT 1",
      hasVariant ? [String(menuItemId), variant || ''] : [String(menuItemId)]
    );
    const current = results && results[0];
    if (current) {
      version = Number(current.version || 1) + 1;
      supersededId = current.id;
      await d1Run(env, "UPDATE recipes SET status = 'archived', archived_at = ? WHERE id = ?", [
        new Date().toISOString(),
        current.id,
      ]);
    }
  }

  const id = await insertRecipe(env, auth, {
    menuItemId, name, variant, version,
    yieldQty: data.yieldQty || data.yield_qty,
    yieldUnit: data.yieldUnit || data.yield_unit,
    notes: data.notes,
    lines: clean,
  });

  await writeAudit(env, auth, {
    action: supersededId ? 'update' : 'create',
    entity: 'recipes',
    entityId: id,
    before: supersededId ? { recipe_id: supersededId, version: version - 1 } : null,
    after: { recipe_id: id, version, menu_item_id: menuItemId, variant, lines: clean.length },
    reason: data.reason || (supersededId ? 'Recipe revised' : null),
  });

  const inventory = await loadInventoryMap(env);
  const cost = recipeCost(clean, inventory);

  return json({ ok: true, id, version, variant, supersededId, cost });
}

/** GET /api/recipes/:id — one recipe with its costed lines. */
async function getRecipe(env, id) {
  const { results } = await d1Query(env, 'SELECT * FROM recipes WHERE id = ?', [id]);
  const recipe = results && results[0];
  if (!recipe) return json({ ok: false, error: 'Recipe not found' }, 404);

  const full = await withLines(env, recipe);
  const inventory = await loadInventoryMap(env);
  const cost = recipeCost(full.lines, inventory, { yieldQty: Number(recipe.yield_qty) || 1 });

  // Cost per line, so the screen can show what is actually driving food cost
  // rather than only the total.
  const lines = full.lines.map((l) => {
    const item = inventory.get(String(l.inventory_id));
    return {
      ...l,
      itemName: item ? item.name : '(missing ingredient)',
      stockUnit: item ? item.unit : null,
      unitCost: item ? Number(item.avg_cost ?? item.cost ?? 0) : 0,
    };
  });

  return json({ ok: true, recipe: { ...recipe, lines }, cost });
}

/**
 * GET /api/recipes/:id/versions — the history for a menu item.
 * Answers "what did this cost when we sold it in June".
 */
async function recipeVersions(env, id) {
  const { results } = await d1Query(env, 'SELECT menu_item_id FROM recipes WHERE id = ?', [id]);
  const row = results && results[0];
  if (!row) return json({ ok: false, error: 'Recipe not found' }, 404);

  const { results: versions } = await d1Query(
    env,
    'SELECT * FROM recipes WHERE menu_item_id = ? ORDER BY version DESC',
    [row.menu_item_id]
  );
  return json({ ok: true, versions: versions || [] });
}

/** GET /api/recipes — every active recipe, costed, with margin against price. */
async function listRecipes(env, url) {
  const menuItemId = url.searchParams.get('menu_item_id') || url.searchParams.get('menuItemId');
  const includeArchived = url.searchParams.get('archived') === 'true';

  const clauses = [];
  const params = [];
  if (menuItemId) { clauses.push('r.menu_item_id = ?'); params.push(menuItemId); }
  if (!includeArchived) clauses.push("r.status = 'active'");
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const { results } = await d1Query(
    env,
    `SELECT r.*, m.name AS menu_item_name, m.price AS menu_item_price
       FROM recipes r LEFT JOIN menu_items m ON m.id = r.menu_item_id
       ${where} ORDER BY r.name`,
    params
  );

  const inventory = await loadInventoryMap(env);
  const { results: allLines } = await d1Query(env, 'SELECT * FROM recipe_items');
  const linesByRecipe = new Map();
  for (const l of allLines || []) {
    if (!linesByRecipe.has(l.recipe_id)) linesByRecipe.set(l.recipe_id, []);
    linesByRecipe.get(l.recipe_id).push(l);
  }

  const out = (results || []).map((r) => {
    const lines = linesByRecipe.get(r.id) || [];
    const cost = recipeCost(lines, inventory, { yieldQty: Number(r.yield_qty) || 1 });
    return {
      ...r,
      lineCount: lines.length,
      cost,
      margin: r.menu_item_price != null ? menuItemMargin(r.menu_item_price, cost.totalCost) : null,
    };
  });

  return json({ ok: true, recipes: out });
}

/**
 * GET /api/recipes/:id/capacity — how many servings current stock supports,
 * and which ingredient runs out first (§28).
 */
async function capacity(env, id, url) {
  const { results } = await d1Query(env, 'SELECT * FROM recipes WHERE id = ?', [id]);
  const recipe = results && results[0];
  if (!recipe) return json({ ok: false, error: 'Recipe not found' }, 404);

  const full = await withLines(env, recipe);
  const inventory = await loadInventoryMap(env);
  const stock = new Map([...inventory].map(([k, v]) => [k, Number(v.stock) || 0]));

  const result = productionCapacity(full.lines, inventory, stock, {
    yieldQty: Number(recipe.yield_qty) || 1,
    // A dine-in serving consumes no takeaway packaging, so the caller says which
    // it is asking about.
    includePackaging: url.searchParams.get('packaging') !== 'false',
  });

  return json({ ok: true, recipe: { id: recipe.id, name: recipe.name }, ...result });
}

/**
 * DELETE /api/recipes/:id — archive.
 *
 * Never removed: order lines point at it, and deleting the row would leave
 * every historical sale unable to explain what it consumed.
 */
async function archiveRecipe(env, auth, id) {
  const { results } = await d1Query(env, 'SELECT * FROM recipes WHERE id = ?', [id]);
  const recipe = results && results[0];
  if (!recipe) return json({ ok: false, error: 'Recipe not found' }, 404);
  if (recipe.status === 'archived') return json({ ok: false, error: 'Already archived' }, 409);

  await d1Run(env, "UPDATE recipes SET status = 'archived', archived_at = ? WHERE id = ?", [
    new Date().toISOString(),
    id,
  ]);
  await writeAudit(env, auth, {
    action: 'void', entity: 'recipes', entityId: id,
    before: { status: recipe.status }, after: { status: 'archived' },
  });
  return json({ ok: true, archived: true });
}

export async function handleRecipes(pathname, method, url, request, env, auth) {
  const m = method.toUpperCase();

  // The unit list the recipe editor's dropdowns are built from, so the client
  // and the conversion engine can never disagree about what a unit is.
  if (pathname === '/api/units' && m === 'GET') {
    return json({ ok: true, units: unitCatalogue() });
  }

  if (!pathname.startsWith('/api/recipes')) return null;
  const sub = pathname.replace(/^\/api\/recipes/, '');

  if (m === 'GET' && sub === '') return listRecipes(env, url);
  if (m === 'POST' && sub === '') return createRecipe(request, env, auth);

  const cap = sub.match(/^\/([^/]+)\/capacity$/);
  if (m === 'GET' && cap) return capacity(env, cap[1], url);

  const ver = sub.match(/^\/([^/]+)\/versions$/);
  if (m === 'GET' && ver) return recipeVersions(env, ver[1]);

  const one = sub.match(/^\/([^/]+)$/);
  if (m === 'GET' && one) return getRecipe(env, one[1]);
  // A PUT is a new version, not an edit — see the module comment.
  if (m === 'PUT' && one) return createRecipe(request, env, auth);
  if (m === 'DELETE' && one) return archiveRecipe(env, auth, one[1]);

  return null;
}
