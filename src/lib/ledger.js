/**
 * The stock ledger — the only way inventory is allowed to change.
 *
 * What this replaces: the single write path for stock was a generic
 * `PUT /api/inventory/:id` that set `stock` to whatever it was handed. The
 * previous quantity was destroyed, nothing recorded who changed it or why, and
 * selling a coffee did not touch coffee at all. §22 of the spec ("do not
 * silently overwrite stock") and §27 ("never simply overwrite the number") both
 * describe that behaviour precisely.
 *
 * Now every change is a `stock_movements` row and `inventory.stock` is the
 * running total of those rows. The consequence worth stating: stock can be
 * rebuilt from the ledger if it is ever doubted, which is the property that
 * makes a variance investigation possible at all.
 *
 * ── Idempotency ─────────────────────────────────────────────────────────────
 *
 * Posting consumption for an order is guarded by `orders.consumed_at`. Without
 * it, a retried request or a double-tapped button deducts the stock twice —
 * the "double inventory deduction" in §56 — and the resulting variance looks
 * exactly like theft. The guard is a conditional UPDATE rather than a
 * read-then-write, so two concurrent posts cannot both win.
 */

import { d1Query, d1Run } from './db.js';
import { actorName } from '../auth.js';
import { expandRecipe, newAverageCost, selectRecipeVariant } from './inventory.js';
import { roundQty } from './units.js';
import { consumeFromBatches, restoreToBatches } from './batches.js';

/** Movement types. A type outside this set is refused rather than stored. */
export const MOVEMENT_TYPES = new Set([
  'purchase',
  'sale',
  'waste',
  'adjustment',
  'production',
  'count',
  'void_reversal',
  'transfer',
]);

/** Types that may drive stock below zero without complaint. */
const MAY_GO_NEGATIVE = new Set(['adjustment', 'count', 'void_reversal']);

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/**
 * Columns on stock_movements, resolved once per isolate.
 *
 * `batch_alloc` arrives with migration 008, so writing it unconditionally would
 * break every stock movement in the window between deploying this Worker and
 * applying that migration. Cached because the schema cannot change under a
 * running isolate.
 */
let MOVEMENT_COLUMNS = null;
async function movementColumns(env) {
  if (MOVEMENT_COLUMNS) return MOVEMENT_COLUMNS;
  try {
    const { results } = await d1Query(env, 'PRAGMA table_info(stock_movements)');
    MOVEMENT_COLUMNS = (results || []).map((c) => c.name);
  } catch {
    MOVEMENT_COLUMNS = [];
  }
  return MOVEMENT_COLUMNS;
}

let ORDER_ITEM_COLUMNS = null;
async function orderItemColumns(env) {
  if (ORDER_ITEM_COLUMNS) return ORDER_ITEM_COLUMNS;
  try {
    const { results } = await d1Query(env, 'PRAGMA table_info(order_items)');
    ORDER_ITEM_COLUMNS = (results || []).map((c) => c.name);
  } catch {
    ORDER_ITEM_COLUMNS = [];
  }
  return ORDER_ITEM_COLUMNS;
}

/** Test seam: forget the cached schema. */
export function resetMovementColumns() {
  MOVEMENT_COLUMNS = null;
  ORDER_ITEM_COLUMNS = null;
}

/**
 * Write one movement and move the running balance with it.
 *
 * @param {object} env
 * @param {object|null} auth
 * @param {object} move
 * @param {string} move.inventoryId
 * @param {number} move.qty        signed, in the item's stocking unit
 * @param {string} move.type
 * @param {string} [move.refType]  orders | purchases | waste | stock_counts
 * @param {string} [move.refId]
 * @param {number} [move.unitCost]
 * @param {string} [move.reason]
 * @param {boolean} [move.allowNegative]
 * @returns {Promise<{ok: boolean, id?: string, balance?: number, error?: string}>}
 */
export async function postMovement(env, auth, move) {
  const type = String(move.type || '').toLowerCase();
  if (!MOVEMENT_TYPES.has(type)) {
    return { ok: false, error: `Unknown movement type "${move.type}"` };
  }
  const qty = num(move.qty);
  if (!qty) return { ok: false, error: 'Movement quantity must be non-zero' };

  const { results } = await d1Query(env, 'SELECT * FROM inventory WHERE id = ?', [
    String(move.inventoryId),
  ]);
  const item = results && results[0];
  if (!item) return { ok: false, error: `Inventory item ${move.inventoryId} not found` };

  const current = num(item.stock);
  const balance = roundQty(current + qty, item.unit);

  // Negative stock is a data problem, not a state to record. Consumption is
  // refused rather than allowed to go below zero, because a negative shelf
  // makes every downstream figure — variance, capacity, value — meaningless.
  // Adjustments and counts are exempt: correcting to a negative is sometimes
  // exactly what a stock take found.
  if (balance < 0 && !MAY_GO_NEGATIVE.has(type) && !move.allowNegative) {
    return {
      ok: false,
      error: `${item.name}: only ${roundQty(current, item.unit)} ${item.unit} in stock, cannot remove ${roundQty(Math.abs(qty), item.unit)}`,
      shortfall: roundQty(Math.abs(balance), item.unit),
    };
  }

  const nowIso = new Date().toISOString();
  const id = 'SM' + crypto.randomUUID().slice(0, 10);
  const unitCost = move.unitCost !== undefined ? num(move.unitCost) : num(item.avg_cost, num(item.cost));

  // Perishables are tracked in batches. Taking stock out has to take it out of
  // a *particular* batch, first-to-expire, or the expiring-stock report keeps
  // counting quantity that was used weeks ago. Items with no batches — most of
  // them — return null and are unaffected.
  let batchAlloc = null;
  if (qty < 0) {
    batchAlloc = await consumeFromBatches(env, item.id, qty);
  } else if (type === 'void_reversal' && move.refType && move.refId) {
    // Put it back where it came from, using the allocation recorded at the
    // time rather than re-deriving one against today's batches.
    await restoreToBatches(env, move.refType, move.refId);
  }

  // batch_alloc arrives with migration 008. Written only when the column
  // exists, so the ledger keeps working either side of it — the same schema
  // tolerance the orders INSERT uses.
  const cols = await movementColumns(env);
  const hasAlloc = cols.includes('batch_alloc');

  await d1Run(
    env,
    `INSERT INTO stock_movements
       (id, at, inventory_id, qty, unit, type, ref_type, ref_id,
        unit_cost, total_cost, balance_after, actor_id, actor_name, reason, notes${hasAlloc ? ', batch_alloc' : ''})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${hasAlloc ? ', ?' : ''})`,
    [
      id,
      move.at || nowIso,
      item.id,
      qty,
      item.unit,
      type,
      move.refType || null,
      move.refId || null,
      unitCost,
      Math.round(Math.abs(qty) * unitCost * 100) / 100,
      balance,
      (auth && auth.staff_id) || null,
      auth ? actorName(auth) : null,
      move.reason || null,
      move.notes || null,
      ...(hasAlloc ? [batchAlloc ? JSON.stringify(batchAlloc) : null] : []),
    ]
  );

  // Receiving stock re-prices it. Done here rather than in the purchase handler
  // so any inbound movement keeps the average honest.
  const fields = ['stock = ?', 'updated_at = ?'];
  const values = [balance, nowIso];
  if (qty > 0 && move.unitCost !== undefined) {
    fields.push('avg_cost = ?', 'last_cost = ?');
    values.push(newAverageCost(current, num(item.avg_cost, num(item.cost)), qty, num(move.unitCost)));
    values.push(num(move.unitCost));
  }
  values.push(item.id);
  await d1Run(env, `UPDATE inventory SET ${fields.join(', ')} WHERE id = ?`, values);

  return { ok: true, id, balance, unit: item.unit };
}

/**
 * Post several movements as one act.
 *
 * All-or-nothing by pre-check: every line is validated against current stock
 * before any is written, so a five-ingredient dish cannot deduct three
 * ingredients and then fail on the fourth. D1 has no interactive transaction
 * here, and a half-consumed recipe is worse than a refused one.
 */
export async function postMovements(env, auth, moves, opts = {}) {
  const results = [];
  const errors = [];

  if (!opts.skipPrecheck) {
    const wanted = new Map();
    for (const m of moves) {
      const key = String(m.inventoryId);
      wanted.set(key, num(wanted.get(key)) + num(m.qty));
    }
    for (const [invId, delta] of wanted) {
      if (delta >= 0) continue;
      const { results: rows } = await d1Query(env, 'SELECT * FROM inventory WHERE id = ?', [invId]);
      const item = rows && rows[0];
      if (!item) { errors.push(`Inventory item ${invId} not found`); continue; }
      if (num(item.stock) + delta < 0 && !opts.allowNegative) {
        errors.push(
          `${item.name}: only ${roundQty(num(item.stock), item.unit)} ${item.unit} in stock, needs ${roundQty(Math.abs(delta), item.unit)}`
        );
      }
    }
    if (errors.length) return { ok: false, posted: 0, errors };
  }

  for (const m of moves) {
    const r = await postMovement(env, auth, { ...m, allowNegative: opts.allowNegative });
    if (r.ok) results.push(r);
    else errors.push(r.error);
  }

  return { ok: errors.length === 0, posted: results.length, movements: results, errors };
}

/**
 * The active recipe for a menu item, with its lines.
 *
 * Returns null when the item has no recipe. That is a legitimate state, not an
 * error: drinks bought in and resold — a bottle of water, a soft drink — have
 * no BOM, and the sale simply consumes nothing beyond the item itself.
 */
export async function activeRecipeFor(env, menuItemId, modifiers) {
  if (!menuItemId) return null;
  // Every active recipe for the dish, because a coffee now legitimately has a
  // Small, a Medium and a Large. selectRecipeVariant picks the one the line was
  // actually ordered as; with no variants defined it returns the single
  // default, which is the behaviour every existing dish keeps.
  const { results } = await d1Query(
    env,
    "SELECT * FROM recipes WHERE menu_item_id = ? AND status = 'active'",
    [String(menuItemId)]
  );
  const recipe = selectRecipeVariant(results || [], modifiers);
  if (!recipe) return null;
  const { results: lines } = await d1Query(
    env,
    'SELECT * FROM recipe_items WHERE recipe_id = ? ORDER BY sort_order, id',
    [recipe.id]
  );
  return { ...recipe, lines: lines || [] };
}

/**
 * Consume the ingredients an order used.
 *
 * This is the join the whole system was missing: the point at which a sale
 * becomes a change in stock. It is called once, when an order reaches a state
 * that means the food was actually made.
 *
 * ── Why it is driven by order_items ─────────────────────────────────────────
 * `orders.items` is prose ("1xMacchiato, 1xFut breakfast Gebeta") and cannot be
 * costed. `order_items` carries the menu id per line, which is what resolves to
 * a recipe. Orders with no tracked lines consume nothing and say so, rather
 * than guessing from the string.
 *
 * ── Why takeaway packaging is decided here ──────────────────────────────────
 * The same macchiato consumes a cup, a lid and a napkin as a takeaway and none
 * of them dine-in. One recipe, one engine, and the order type decides — which
 * is what §60 asks for and why there is no separate takeaway inventory.
 */
export async function consumeForOrder(env, auth, orderId, opts = {}) {
  const { results } = await d1Query(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
  const order = results && results[0];
  if (!order) return { ok: false, error: 'Order not found' };
  if (order.voided_at) return { ok: false, error: 'Order is voided' };

  // Claim the order before doing any work. A conditional UPDATE is the guard:
  // two concurrent posts race here and exactly one sees changes === 1, so the
  // stock is never taken twice for one sale.
  const nowIso = new Date().toISOString();
  const { meta } = await d1Run(
    env,
    'UPDATE orders SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL',
    [nowIso, orderId]
  );
  if (!meta.changes) {
    return { ok: true, alreadyPosted: true, posted: 0, movements: [] };
  }

  try {
    const { results: lines } = await d1Query(
      env,
      "SELECT * FROM order_items WHERE order_id = ? AND status <> 'cancelled'",
      [orderId]
    );
    if (!lines || !lines.length) {
      return { ok: true, posted: 0, movements: [], warning: 'Order has no tracked lines to consume against' };
    }

    const { results: invRows } = await d1Query(env, 'SELECT * FROM inventory WHERE active IS NULL OR active = 1');
    const itemsById = new Map((invRows || []).map((i) => [String(i.id), i]));

    // Takeaway and delivery both leave the building, so both consume packaging.
    const includePackaging = order.type === 'takeaway' || order.type === 'delivery';

    const moves = [];
    const perLineCost = [];
    const warnings = [];

    for (const line of lines) {
      // The line's modifiers decide which size was ordered, so a large coffee
      // consumes the large recipe's 25 g rather than the medium's 18 g.
      const recipe = await activeRecipeFor(env, line.menu_item_id, line.modifiers);
      if (!recipe) {
        // Bought-in goods have no BOM. Recorded so the manager can tell "no
        // recipe" apart from "recipe consumed nothing".
        warnings.push(`${line.name}: no active recipe, nothing consumed`);
        continue;
      }

      const { lines: expanded, errors } = expandRecipe(
        recipe.lines,
        itemsById,
        num(line.qty, 1),
        { includePackaging, yieldQty: num(recipe.yield_qty, 1) }
      );
      warnings.push(...errors.map((e) => `${line.name}: ${e}`));

      let ingredientCost = 0;
      let packagingCost = 0;
      for (const l of expanded) {
        moves.push({
          inventoryId: l.inventoryId,
          qty: -l.quantity,
          type: 'sale',
          refType: 'orders',
          refId: orderId,
          reason: `${line.qty}× ${line.name}`,
        });
        const c = l.quantity * l.unitCost;
        if (l.isPackaging) packagingCost += c;
        else ingredientCost += c;
      }

      perLineCost.push({
        id: line.id,
        recipeId: recipe.id,
        variant: recipe.variant || null,
        ingredientCost: Math.round(ingredientCost * 100) / 100,
        packagingCost: Math.round(packagingCost * 100) / 100,
      });
    }

    const posted = await postMovements(env, auth, moves, {
      // Stock going negative means the shelf and the system already disagree.
      // Blocking a sale that has happened does not put the ingredient back, and
      // it would leave the guest's order unrecorded. Post it, let the variance
      // report surface it, and let a stock count settle it.
      allowNegative: opts.allowNegative !== false,
    });

    // Snapshot the recipe and its cost onto the line. This is what stops a
    // recipe change from rewriting history: last month's margin reports read
    // these columns, not today's recipe (§25).
    // recipe_variant arrives with migration 009; written only when the column
    // exists so consumption keeps working either side of it.
    const itemCols = await orderItemColumns(env);
    const hasVariant = itemCols.includes('recipe_variant');
    for (const c of perLineCost) {
      await d1Run(
        env,
        hasVariant
          ? 'UPDATE order_items SET recipe_id = ?, recipe_variant = ?, ingredient_cost = ?, packaging_cost = ? WHERE id = ?'
          : 'UPDATE order_items SET recipe_id = ?, ingredient_cost = ?, packaging_cost = ? WHERE id = ?',
        hasVariant
          ? [c.recipeId, c.variant, c.ingredientCost, c.packagingCost, c.id]
          : [c.recipeId, c.ingredientCost, c.packagingCost, c.id]
      );
    }

    return {
      ok: true,
      posted: posted.posted,
      movements: posted.movements,
      warnings: [...warnings, ...posted.errors],
    };
  } catch (e) {
    // Release the claim so the post can be retried, rather than leaving the
    // order marked consumed with nothing actually deducted.
    await d1Run(env, 'UPDATE orders SET consumed_at = NULL WHERE id = ?', [orderId]);
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * Put back what a voided order took.
 *
 * A reversal, not a deletion: the original sale movements stay, and a matching
 * set of positive `void_reversal` rows is added. The ledger therefore shows
 * that the stock went out and came back, which is what happened.
 */
export async function reverseOrderConsumption(env, auth, orderId, reason) {
  const { results } = await d1Query(
    env,
    "SELECT * FROM stock_movements WHERE ref_type = 'orders' AND ref_id = ? AND type = 'sale'",
    [orderId]
  );
  const sales = results || [];
  if (!sales.length) return { ok: true, posted: 0 };

  const { results: already } = await d1Query(
    env,
    "SELECT id FROM stock_movements WHERE ref_type = 'orders' AND ref_id = ? AND type = 'void_reversal' LIMIT 1",
    [orderId]
  );
  if (already && already.length) return { ok: true, posted: 0, alreadyReversed: true };

  const moves = sales.map((s) => ({
    inventoryId: s.inventory_id,
    qty: -num(s.qty), // sale rows are negative, so this returns stock
    type: 'void_reversal',
    refType: 'orders',
    refId: orderId,
    unitCost: num(s.unit_cost),
    reason: reason || 'Order voided',
  }));

  const posted = await postMovements(env, auth, moves, { skipPrecheck: true });
  await d1Run(env, 'UPDATE orders SET consumed_at = NULL WHERE id = ?', [orderId]);
  return posted;
}
