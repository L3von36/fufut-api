/**
 * Inventory operations and reporting.
 *
 * The generic resource handler still serves plain `GET /api/inventory` and the
 * create/edit of an item's catalogue record, which works and is left alone.
 * What moves here is everything that changes a *quantity*, because quantities
 * now belong to the ledger (lib/ledger.js) rather than to a column somebody
 * types into.
 *
 * The behaviour being replaced: `PUT /api/inventory/:id` with `{stock: 19.8}`
 * set the number and destroyed the previous one. The Inventory screen's ±1
 * buttons did exactly that. §22 and §27 of the spec both forbid it, and it is
 * the reason no variance could ever be investigated — there was no record of
 * what stock had been, only what it currently was.
 */

import { d1Query, d1Run, json, readBody } from '../lib/db.js';
import { writeAudit } from '../lib/audit.js';
import { actorName } from '../auth.js';
import { postMovement } from '../lib/ledger.js';
import {
  consumptionVariance,
  stockReconciliation,
  forecastRunout,
  reorderSuggestion,
  productionCapacity,
  expandRecipe,
} from '../lib/inventory.js';
import { roundQty } from '../lib/units.js';

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function daysBetween(from, to) {
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86400000));
}

/** Default reporting window: the last 30 days. */
function windowFrom(url) {
  const to = url.searchParams.get('to') || new Date().toISOString();
  const from =
    url.searchParams.get('from') || new Date(Date.now() - 30 * 86400000).toISOString();
  return { from, to };
}

/**
 * POST /api/inventory/:id/adjust — the replacement for typing a new number.
 *
 * A reason is required. An adjustment without one is indistinguishable from a
 * mistake later, and the entire value of the ledger is that a figure can be
 * explained months afterwards.
 */
async function adjust(request, env, auth, id) {
  const data = await readBody(request);
  if (!data) return json({ ok: false, error: 'Invalid JSON body' }, 400);

  const reason = String(data.reason || '').trim();
  if (!reason) {
    return json({ ok: false, error: 'A reason is required for a stock adjustment' }, 400);
  }

  const { results } = await d1Query(env, 'SELECT * FROM inventory WHERE id = ?', [id]);
  const item = results && results[0];
  if (!item) return json({ ok: false, error: 'Inventory item not found' }, 404);

  // Two ways to express the same act: "add 5" or "it is actually 19.8". The
  // second is what a person holding a scale says, so both are accepted and both
  // become a signed delta.
  let delta;
  if (data.newQty !== undefined || data.actual !== undefined) {
    const target = num(data.newQty !== undefined ? data.newQty : data.actual);
    delta = target - num(item.stock);
  } else {
    delta = num(data.qty ?? data.delta);
  }
  if (!delta) return json({ ok: false, error: 'Adjustment would not change the quantity' }, 400);

  const result = await postMovement(env, auth, {
    inventoryId: id,
    qty: delta,
    type: String(data.type || 'adjustment').toLowerCase() === 'count' ? 'count' : 'adjustment',
    refType: data.refType || null,
    refId: data.refId || null,
    reason,
    notes: data.notes || null,
  });
  if (!result.ok) return json({ ok: false, error: result.error }, 400);

  await writeAudit(env, auth, {
    action: 'adjust',
    entity: 'inventory',
    entityId: id,
    before: { stock: num(item.stock) },
    after: { stock: result.balance },
    reason,
  });

  return json({
    ok: true,
    previous: roundQty(num(item.stock), item.unit),
    change: roundQty(delta, item.unit),
    stock: result.balance,
    unit: item.unit,
  });
}

/** GET /api/inventory/:id/movements — the statement for one item. */
async function movements(env, url, id) {
  const { from, to } = windowFrom(url);
  const { results } = await d1Query(
    env,
    'SELECT * FROM stock_movements WHERE inventory_id = ? AND at >= ? AND at <= ? ORDER BY at DESC LIMIT 500',
    [id, from, to]
  );
  return json({ ok: true, from, to, movements: results || [] });
}

/**
 * GET /api/inventory/variance — expected against actual, per ingredient.
 *
 * Expected comes from what the ledger says was consumed by sales; actual comes
 * from every other outward movement plus waste. The comparison the spec's §21
 * asks for, and the reason the ledger records a `type` on every row.
 */
async function variance(env, url) {
  const { from, to } = windowFrom(url);

  const { results } = await d1Query(
    env,
    `SELECT m.inventory_id,
            i.name, i.unit,
            SUM(CASE WHEN m.type = 'sale'       THEN -m.qty ELSE 0 END) AS sold,
            SUM(CASE WHEN m.type = 'waste'      THEN -m.qty ELSE 0 END) AS wasted,
            SUM(CASE WHEN m.type = 'purchase'   THEN  m.qty ELSE 0 END) AS purchased,
            SUM(CASE WHEN m.type IN ('adjustment','count') THEN m.qty ELSE 0 END) AS adjusted
       FROM stock_movements m
       JOIN inventory i ON i.id = m.inventory_id
      WHERE m.at >= ? AND m.at <= ?
      GROUP BY m.inventory_id, i.name, i.unit`,
    [from, to]
  );

  const rows = (results || []).map((r) => {
    // Theoretical usage is what the recipes say the sales should have taken.
    // Actual is that plus whatever an adjustment or a count had to correct —
    // a negative correction is stock that left without being sold.
    const expected = num(r.sold);
    const correction = -Math.min(0, num(r.adjusted));
    const actual = expected + correction;
    return {
      inventoryId: r.inventory_id,
      name: r.name,
      unit: r.unit,
      purchased: roundQty(num(r.purchased), r.unit),
      wasted: roundQty(num(r.wasted), r.unit),
      ...consumptionVariance(expected, actual, r.unit),
    };
  });

  // Biggest discrepancies first: that is the order a manager investigates in.
  rows.sort((a, b) => Math.abs(num(b.variancePct)) - Math.abs(num(a.variancePct)));

  return json({
    ok: true, from, to,
    items: rows,
    note: 'Variance is a question, not a finding. Waste, portioning, preparation loss and counting errors all produce it.',
  });
}

/** GET /api/inventory/:id/reconciliation — the §27 statement for one item. */
async function reconciliation(env, url, id) {
  const { from, to } = windowFrom(url);
  const { results: rows } = await d1Query(env, 'SELECT * FROM inventory WHERE id = ?', [id]);
  const item = rows && rows[0];
  if (!item) return json({ ok: false, error: 'Inventory item not found' }, 404);

  // Opening is the balance carried by the last movement before the window.
  const { results: before } = await d1Query(
    env,
    'SELECT balance_after FROM stock_movements WHERE inventory_id = ? AND at < ? ORDER BY at DESC LIMIT 1',
    [id, from]
  );
  const opening = before && before.length ? num(before[0].balance_after) : 0;

  const { results: agg } = await d1Query(
    env,
    `SELECT SUM(CASE WHEN type = 'purchase' THEN qty ELSE 0 END) AS purchased,
            SUM(CASE WHEN type = 'sale'     THEN -qty ELSE 0 END) AS used,
            SUM(CASE WHEN type = 'waste'    THEN -qty ELSE 0 END) AS wasted
       FROM stock_movements WHERE inventory_id = ? AND at >= ? AND at <= ?`,
    [id, from, to]
  );
  const a = (agg && agg[0]) || {};

  return json({
    ok: true, from, to,
    item: { id: item.id, name: item.name, unit: item.unit },
    ...stockReconciliation({
      opening,
      purchased: num(a.purchased),
      expectedUsage: num(a.used),
      wasted: num(a.wasted),
      actualClosing: num(item.stock),
      unit: item.unit,
    }),
  });
}

/**
 * GET /api/inventory/forecast — days of cover per item.
 *
 * Usage is averaged over the movements actually recorded, and the number of
 * days those movements span is passed through so forecastRunout can refuse to
 * predict from too little history rather than inventing a figure.
 */
async function forecast(env, url) {
  const { from, to } = windowFrom(url);
  const spanDays = daysBetween(from, to) || 1;

  const { results } = await d1Query(
    env,
    `SELECT i.id, i.name, i.unit, i.stock,
            SUM(CASE WHEN m.type IN ('sale','waste','production') THEN -m.qty ELSE 0 END) AS used,
            MIN(m.at) AS first_move
       FROM inventory i
       LEFT JOIN stock_movements m
         ON m.inventory_id = i.id AND m.at >= ? AND m.at <= ?
      WHERE i.active IS NULL OR i.active = 1
      GROUP BY i.id, i.name, i.unit, i.stock`,
    [from, to]
  );

  const items = (results || []).map((r) => {
    // History is bounded by when the item actually started moving, not by the
    // requested window: an ingredient added last week has a week of history
    // however wide the query.
    const history = r.first_move ? Math.min(spanDays, daysBetween(r.first_move, to) || 1) : 0;
    const daily = history > 0 ? num(r.used) / history : 0;
    return {
      inventoryId: r.id,
      name: r.name,
      unit: r.unit,
      stock: roundQty(num(r.stock), r.unit),
      ...forecastRunout(num(r.stock), daily, history, new Date(to)),
    };
  });

  // Soonest to run out first; items with no projection sink to the bottom
  // rather than sorting as zero, which would put them at the top as urgent.
  items.sort((a, b) => {
    if (a.daysRemaining === null) return 1;
    if (b.daysRemaining === null) return -1;
    return a.daysRemaining - b.daysRemaining;
  });

  return json({ ok: true, from, to, items });
}

/** GET /api/inventory/reorder — the manager's buying list (§30). */
async function reorder(env) {
  const { results } = await d1Query(
    env,
    `SELECT i.*, s.name AS supplier_name
       FROM inventory i LEFT JOIN suppliers s ON s.id = i.preferred_supplier_id
      WHERE i.active IS NULL OR i.active = 1`
  );

  const suggestions = [];
  for (const item of results || []) {
    const s = reorderSuggestion(item, num(item.stock));
    if (s) suggestions.push({ ...s, preferredSupplier: item.supplier_name || null });
  }

  const rank = { 'out-of-stock': 0, critical: 1, low: 2 };
  suggestions.sort((a, b) => rank[a.urgency] - rank[b.urgency]);

  return json({
    ok: true,
    count: suggestions.length,
    estimatedTotal: Math.round(suggestions.reduce((s, i) => s + num(i.estimatedCost), 0) * 100) / 100,
    items: suggestions,
  });
}

/**
 * GET /api/inventory/capacity — "what can we make?" across the whole menu.
 *
 * Per-recipe capacity is in handlers/recipes.js; this answers the same question
 * for everything at once, which is what the manager's dashboard shows.
 */
async function menuCapacity(env, url) {
  const includePackaging = url.searchParams.get('packaging') !== 'false';

  const [{ results: recipes }, { results: inv }, { results: lines }] = await Promise.all([
    d1Query(env, "SELECT * FROM recipes WHERE status = 'active'"),
    d1Query(env, 'SELECT * FROM inventory'),
    d1Query(env, 'SELECT * FROM recipe_items'),
  ]);

  const itemsById = new Map((inv || []).map((i) => [String(i.id), i]));
  const stock = new Map((inv || []).map((i) => [String(i.id), num(i.stock)]));
  const byRecipe = new Map();
  for (const l of lines || []) {
    if (!byRecipe.has(l.recipe_id)) byRecipe.set(l.recipe_id, []);
    byRecipe.get(l.recipe_id).push(l);
  }

  const out = (recipes || []).map((r) => {
    const cap = productionCapacity(byRecipe.get(r.id) || [], itemsById, stock, {
      yieldQty: num(r.yield_qty, 1),
      includePackaging,
    });
    return {
      recipeId: r.id,
      menuItemId: r.menu_item_id,
      name: r.name,
      possible: cap.possible,
      limiting: cap.limiting,
      limitingId: cap.limitingId,
    };
  });

  out.sort((a, b) => num(a.possible, Infinity) - num(b.possible, Infinity));
  return json({ ok: true, items: out });
}

/**
 * GET /api/inventory/usage/:id — which dishes consume this ingredient (§24).
 *
 * The shared-ingredient question: sugar goes into tea, coffee and juice, and
 * the manager needs to see the whole draw on it rather than per-dish figures
 * that never add up to the tin that emptied.
 */
async function ingredientUsage(env, url, id) {
  const { from, to } = windowFrom(url);

  const [{ results: recipesUsing }, { results: sold }] = await Promise.all([
    d1Query(
      env,
      `SELECT r.id AS recipe_id, r.name AS recipe_name, r.yield_qty,
              ri.qty, ri.unit, ri.waste_pct, ri.is_packaging, ri.inventory_id
         FROM recipe_items ri
         JOIN recipes r ON r.id = ri.recipe_id
        WHERE ri.inventory_id = ? AND r.status = 'active'`,
      [id]
    ),
    d1Query(
      env,
      `SELECT ABS(SUM(m.qty)) AS total, m.reason
         FROM stock_movements m
        WHERE m.inventory_id = ? AND m.type = 'sale' AND m.at >= ? AND m.at <= ?
        GROUP BY m.reason ORDER BY total DESC LIMIT 50`,
      [id, from, to]
    ),
  ]);

  const { results: rows } = await d1Query(env, 'SELECT * FROM inventory WHERE id = ?', [id]);
  const item = rows && rows[0];
  if (!item) return json({ ok: false, error: 'Inventory item not found' }, 404);

  const itemsById = new Map([[String(id), item]]);
  const usedBy = (recipesUsing || []).map((r) => {
    const { lines: exp } = expandRecipe([r], itemsById, 1, { yieldQty: num(r.yield_qty, 1) });
    return {
      recipeId: r.recipe_id,
      recipeName: r.recipe_name,
      perServing: exp.length ? roundQty(exp[0].perServing, item.unit) : null,
      unit: item.unit,
      isPackaging: !!r.is_packaging,
    };
  });

  return json({
    ok: true, from, to,
    item: { id: item.id, name: item.name, unit: item.unit, stock: roundQty(num(item.stock), item.unit) },
    usedBy,
    consumedBy: (sold || []).map((s) => ({ description: s.reason, quantity: roundQty(num(s.total), item.unit) })),
  });
}

/**
 * GET /api/inventory/expiring — batches at or near their date (§37).
 */
async function expiring(env, url) {
  const days = Math.max(1, parseInt(url.searchParams.get('days'), 10) || 7);
  const horizon = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  const todayStr = new Date().toISOString().slice(0, 10);

  const { results } = await d1Query(
    env,
    `SELECT b.*, i.name, i.unit
       FROM inventory_batches b JOIN inventory i ON i.id = b.inventory_id
      WHERE b.status = 'open' AND b.qty_remaining > 0
        AND b.expiry_date IS NOT NULL AND b.expiry_date <= ?
      ORDER BY b.expiry_date`,
    [horizon]
  );

  const batches = (results || []).map((b) => ({
    ...b,
    expired: b.expiry_date < todayStr,
    daysLeft: daysBetween(todayStr, b.expiry_date) * (b.expiry_date < todayStr ? -1 : 1),
  }));

  return json({
    ok: true,
    horizonDays: days,
    expired: batches.filter((b) => b.expired),
    expiringSoon: batches.filter((b) => !b.expired),
  });
}

/**
 * POST /api/inventory/count — post a physical stock take.
 *
 * Each line becomes an adjustment movement carrying the variance and its
 * reason. §27 is explicit that the number must not simply be overwritten, and
 * this is where that rule is enforced: the count records what was found, and
 * the difference from what the system believed becomes its own fact.
 */
async function postCount(request, env, auth) {
  const data = await readBody(request);
  if (!data || !Array.isArray(data.items) || !data.items.length) {
    return json({ ok: false, error: 'A count needs at least one item' }, 400);
  }

  const nowIso = new Date().toISOString();
  const countId = 'SC' + crypto.randomUUID().slice(0, 10);
  await d1Run(
    env,
    `INSERT INTO stock_counts (id, started_at, completed_at, status, counted_by, counted_by_name, notes)
     VALUES (?, ?, ?, 'posted', ?, ?, ?)`,
    [
      countId, data.startedAt || nowIso, nowIso,
      (auth && auth.staff_id) || null,
      auth ? actorName(auth) : null,
      data.notes || null,
    ]
  );

  const lines = [];
  for (const line of data.items) {
    const invId = String(line.inventoryId || line.inventory_id || '');
    const { results } = await d1Query(env, 'SELECT * FROM inventory WHERE id = ?', [invId]);
    const item = results && results[0];
    if (!item) { lines.push({ inventoryId: invId, error: 'not found' }); continue; }

    const systemQty = num(item.stock);
    const countedQty = num(line.countedQty ?? line.counted ?? line.qty);
    const varianceQty = countedQty - systemQty;

    await d1Run(
      env,
      `INSERT INTO stock_count_items
         (id, count_id, inventory_id, system_qty, counted_qty, variance, unit, reason, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'SCI' + crypto.randomUUID().slice(0, 9),
        countId, invId, systemQty, countedQty, varianceQty, item.unit,
        line.reason || 'Physical stock count', line.notes || null,
      ]
    );

    // Zero variance still records the count — knowing an item reconciled
    // cleanly is a result — but writes no movement, because nothing moved.
    if (Math.abs(varianceQty) > 1e-9) {
      await postMovement(env, auth, {
        inventoryId: invId,
        qty: varianceQty,
        type: 'count',
        refType: 'stock_counts',
        refId: countId,
        reason: line.reason || 'Physical stock count',
      });
    }

    lines.push({
      inventoryId: invId, name: item.name, unit: item.unit,
      system: roundQty(systemQty, item.unit),
      counted: roundQty(countedQty, item.unit),
      variance: roundQty(varianceQty, item.unit),
    });
  }

  await writeAudit(env, auth, {
    action: 'adjust', entity: 'stock_counts', entityId: countId,
    after: { items: lines.length },
    reason: data.notes || 'Physical stock count',
  });

  return json({ ok: true, countId, items: lines });
}

/**
 * POST /api/waste — record what was thrown away, and take it off the shelf.
 *
 * The waste screen has always logged the reason and the quantity and has never
 * reduced stock, so wasted food stayed on the books as though it were still
 * there. That inflated inventory value, hid the shortage from the reorder list,
 * and then reappeared as unexplained variance at the next count — the waste was
 * recorded twice and subtracted never.
 *
 * Waste is deliberately its own movement type rather than folded into
 * consumption: §26 requires it to be separable, because "we sold it" and "we
 * binned it" are different facts about the same missing ingredient.
 */
async function recordWaste(request, env, auth) {
  const data = await readBody(request);
  if (!data) return json({ ok: false, error: 'Invalid JSON body' }, 400);

  const invId = String(data.inventoryId || data.inventory_id || data.item_id || '');
  const qty = Math.abs(num(data.qty));
  if (!invId) return json({ ok: false, error: 'inventoryId required' }, 400);
  if (qty <= 0) return json({ ok: false, error: 'Waste quantity must be greater than zero' }, 400);

  const reason = String(data.reason || '').trim();
  if (!reason) {
    // Waste with no reason cannot be acted on. The whole value of the log is
    // telling spoilage apart from burning apart from over-portioning.
    return json({ ok: false, error: 'A reason is required to record waste' }, 400);
  }

  const { results } = await d1Query(env, 'SELECT * FROM inventory WHERE id = ?', [invId]);
  const item = results && results[0];
  if (!item) return json({ ok: false, error: 'Inventory item not found' }, 404);

  const nowIso = new Date().toISOString();
  const id = 'W' + crypto.randomUUID().slice(0, 8);
  const unitCost = num(item.avg_cost, num(item.cost));

  await d1Run(
    env,
    `INSERT INTO waste (id, item_id, inventory_id, qty, unit, reason, est_cost, logged_by, date, notes, posted_at, created)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, invId, invId, qty, item.unit, reason,
      Math.round(qty * unitCost * 100) / 100,
      auth ? actorName(auth) : null,
      data.date || nowIso.slice(0, 10),
      data.notes || null, nowIso, nowIso,
    ]
  );

  const move = await postMovement(env, auth, {
    inventoryId: invId,
    qty: -qty,
    type: 'waste',
    refType: 'waste',
    refId: id,
    reason,
    // Binning something the system already thought was gone is a real event.
    // Refusing it would leave the waste unrecorded and the discrepancy hidden.
    allowNegative: true,
  });

  await writeAudit(env, auth, {
    action: 'create', entity: 'waste', entityId: id,
    after: { inventory_id: invId, qty, unit: item.unit, est_cost: Math.round(qty * unitCost * 100) / 100 },
    reason,
  });

  return json({
    ok: true, id,
    stock: move.ok ? move.balance : undefined,
    unit: item.unit,
    estimatedCost: Math.round(qty * unitCost * 100) / 100,
    warning: move.ok ? undefined : move.error,
  });
}

export async function handleWaste(pathname, method, request, env, auth) {
  if (pathname !== '/api/waste' || method.toUpperCase() !== 'POST') return null;
  const body = await readBody(request.clone());
  // Legacy rows name an item as free text with no inventory link. Those still
  // go through the generic handler so the existing screen keeps working; only a
  // waste record that names a real ingredient can move stock.
  if (!body || !(body.inventoryId || body.inventory_id)) return null;
  return recordWaste(new Request(request.url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }), env, auth);
}

export async function handleInventory(pathname, method, url, request, env, auth) {
  if (!pathname.startsWith('/api/inventory')) return null;
  const m = method.toUpperCase();
  const sub = pathname.replace(/^\/api\/inventory/, '');

  // Collection routes first, so "variance" and "forecast" are never read as an
  // item id — the same ordering trap the kitchen's /items/active route has.
  if (m === 'GET' && sub === '/variance') return variance(env, url);
  if (m === 'GET' && sub === '/forecast') return forecast(env, url);
  if (m === 'GET' && sub === '/reorder') return reorder(env);
  if (m === 'GET' && sub === '/capacity') return menuCapacity(env, url);
  if (m === 'GET' && sub === '/expiring') return expiring(env, url);
  if (m === 'POST' && sub === '/count') return postCount(request, env, auth);

  const usage = sub.match(/^\/usage\/([^/]+)$/);
  if (m === 'GET' && usage) return ingredientUsage(env, url, usage[1]);

  const adj = sub.match(/^\/([^/]+)\/adjust$/);
  if (m === 'POST' && adj) return adjust(request, env, auth, adj[1]);

  const mv = sub.match(/^\/([^/]+)\/movements$/);
  if (m === 'GET' && mv) return movements(env, url, mv[1]);

  const rec = sub.match(/^\/([^/]+)\/reconciliation$/);
  if (m === 'GET' && rec) return reconciliation(env, url, rec[1]);

  // A direct write to `stock` is how the overwrite bug worked. Refused with a
  // pointer at the endpoint that records the same change properly, rather than
  // silently ignoring the field and appearing to succeed.
  if (m === 'PUT' && /^\/[^/]+$/.test(sub)) {
    // Cloned, because a Request body can only be read once. Reading the
    // original here would leave nothing for the generic resource handler to
    // parse when this falls through, and every non-quantity edit would fail
    // with "Invalid JSON body".
    const body = await readBody(request.clone());
    if (body && (body.stock !== undefined || body.quantity !== undefined)) {
      return json(
        {
          ok: false,
          error: 'Stock cannot be set directly. Use POST /api/inventory/:id/adjust with a reason, or POST /api/inventory/count.',
        },
        400
      );
    }
    // No quantity involved — renaming, recategorising, setting a reorder point.
    // Falls through to the generic resource handler, which does that correctly.
    return null;
  }

  return null;
}
