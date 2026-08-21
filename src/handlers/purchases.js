/**
 * Suppliers and purchases.
 *
 * This closes the supply side of the loop the spec draws:
 *
 *   SUPPLIER → PURCHASE → INVENTORY → SUPPLIER BALANCE → EXPENSE → ACCOUNTING
 *
 * Neither table existed. Stock arrived by somebody typing a bigger number into
 * the inventory screen, so there was no record of who supplied it, what it
 * cost, or whether it had been paid for — and "which suppliers do we owe" had
 * no answer anywhere in the system.
 *
 * ── Receiving is what moves stock ───────────────────────────────────────────
 * A purchase can be recorded as ordered before it arrives. Stock moves when it
 * is *received*, posted through the same ledger every other movement uses, and
 * `posted_at` makes that idempotent so a delivery cannot be booked in twice.
 *
 * ── Balances are derived ────────────────────────────────────────────────────
 * A supplier's outstanding balance is SUM(total - paid) over their purchases,
 * computed on read. A stored running balance would be one write away from
 * disagreeing with the purchases behind it, and reconciling it against a
 * paper invoice is the entire point.
 */

import { d1Query, d1Run, json, readBody } from '../lib/db.js';
import { writeAudit } from '../lib/audit.js';
import { actorName, isManager } from '../auth.js';
import { postMovement } from '../lib/ledger.js';
import { convert, areCompatible, isKnownUnit } from '../lib/units.js';
import { purchaseAnalysis } from '../lib/inventory.js';

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function round2(n) {
  return Math.round(num(n) * 100) / 100;
}

// ── Suppliers ───────────────────────────────────────────────────────────────

/** GET /api/suppliers — with each one's outstanding balance. */
async function listSuppliers(env, url) {
  const category = url.searchParams.get('category');
  const clauses = [];
  const params = [];
  if (category) { clauses.push('s.category = ?'); params.push(category); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const { results } = await d1Query(
    env,
    `SELECT s.*,
            COUNT(p.id)                            AS purchase_count,
            COALESCE(SUM(p.total), 0)              AS total_purchased,
            COALESCE(SUM(p.paid), 0)               AS total_paid,
            COALESCE(SUM(p.total - p.paid), 0)     AS balance,
            MAX(p.date)                            AS last_purchase
       FROM suppliers s
       LEFT JOIN purchases p ON p.supplier_id = s.id AND p.voided_at IS NULL
       ${where}
      GROUP BY s.id
      ORDER BY balance DESC, s.name`,
    params
  );

  return json(
    (results || []).map((r) => ({
      ...r,
      total_purchased: round2(r.total_purchased),
      total_paid: round2(r.total_paid),
      balance: round2(r.balance),
    }))
  );
}

async function createSupplier(request, env, auth) {
  const data = await readBody(request);
  if (!data) return json({ ok: false, error: 'Invalid JSON body' }, 400);
  const name = String(data.name || '').trim();
  if (!name) return json({ ok: false, error: 'A supplier needs a name' }, 400);

  const id = data.id || 'SUP' + crypto.randomUUID().slice(0, 7);
  const nowIso = new Date().toISOString();
  await d1Run(
    env,
    `INSERT INTO suppliers (id, name, category, contact, phone, email, address, supplies, notes, status, created, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, name, data.category || null, data.contact || null, data.phone || null,
      data.email || null, data.address || null,
      Array.isArray(data.supplies) ? data.supplies.join(', ') : data.supplies || null,
      data.notes || null, data.status || 'active', nowIso, nowIso,
    ]
  );

  await writeAudit(env, auth, {
    action: 'create', entity: 'suppliers', entityId: id,
    after: { name, category: data.category || null },
  });
  return json({ ok: true, id });
}

/** GET /api/suppliers/:id — the statement a manager checks against an invoice. */
async function supplierStatement(env, id) {
  const { results } = await d1Query(env, 'SELECT * FROM suppliers WHERE id = ?', [id]);
  const supplier = results && results[0];
  if (!supplier) return json({ ok: false, error: 'Supplier not found' }, 404);

  const { results: purchases } = await d1Query(
    env,
    'SELECT * FROM purchases WHERE supplier_id = ? AND voided_at IS NULL ORDER BY date DESC LIMIT 200',
    [id]
  );

  const rows = purchases || [];
  const totals = rows.reduce(
    (acc, p) => ({
      purchased: acc.purchased + num(p.total),
      paid: acc.paid + num(p.paid),
    }),
    { purchased: 0, paid: 0 }
  );

  return json({
    ok: true,
    supplier,
    purchases: rows,
    totals: {
      purchased: round2(totals.purchased),
      paid: round2(totals.paid),
      balance: round2(totals.purchased - totals.paid),
    },
  });
}

// ── Purchases ───────────────────────────────────────────────────────────────

/**
 * POST /api/purchases — record a delivery and book its stock in.
 *
 * Lines are validated in full before anything is written, so a five-line
 * delivery cannot book three items and then fail on a bad unit, leaving the
 * purchase half-received with no obvious way to finish it.
 */
async function createPurchase(request, env, auth) {
  const data = await readBody(request);
  if (!data) return json({ ok: false, error: 'Invalid JSON body' }, 400);

  const items = Array.isArray(data.items) ? data.items : [];
  if (!items.length) return json({ ok: false, error: 'A purchase needs at least one line' }, 400);

  const { results: invRows } = await d1Query(env, 'SELECT * FROM inventory');
  const inventory = new Map((invRows || []).map((i) => [String(i.id), i]));

  const problems = [];
  const clean = [];
  items.forEach((line, i) => {
    const label = `Line ${i + 1}`;
    const invId = String(line.inventoryId || line.inventory_id || '');
    const item = inventory.get(invId);
    if (!item) { problems.push(`${label}: ingredient not found`); return; }

    const qty = num(line.qty);
    if (qty <= 0) { problems.push(`${label} (${item.name}): quantity must be greater than zero`); return; }

    const unit = String(line.unit || item.unit);
    if (!isKnownUnit(unit)) { problems.push(`${label} (${item.name}): unknown unit "${unit}"`); return; }

    // Buying in a pack unit the item is not stocked in needs the item's pack
    // size, which is per-item data. Without it there is no honest conversion.
    let qtyInStockUnit;
    if (areCompatible(unit, item.unit)) {
      qtyInStockUnit = convert(qty, unit, item.unit);
    } else if (num(item.pack_size) > 0) {
      qtyInStockUnit = qty * num(item.pack_size);
    } else {
      problems.push(
        `${label} (${item.name}): bought in ${unit} but stocked in ${item.unit}. Set a pack size on the item to convert.`
      );
      return;
    }

    const totalCost = line.totalCost !== undefined ? num(line.totalCost) : num(line.unitCost) * qty;
    clean.push({
      inventoryId: invId,
      name: item.name,
      qty,
      unit,
      qtyInStockUnit,
      stockUnit: item.unit,
      // Cost per stocking unit, which is what the ledger and the weighted
      // average need — a price per box is meaningless against stock in pieces.
      unitCostInStockUnit: qtyInStockUnit > 0 ? totalCost / qtyInStockUnit : 0,
      totalCost,
      batchNo: line.batchNo || line.batch_no || null,
      expiryDate: line.expiryDate || line.expiry_date || null,
      trackExpiry: !!item.track_expiry,
    });
  });

  if (problems.length) return json({ ok: false, error: 'Purchase is not valid', problems }, 400);

  const total = data.total !== undefined ? num(data.total) : clean.reduce((s, l) => s + l.totalCost, 0);
  const paid = num(data.paid);
  const nowIso = new Date().toISOString();
  const id = 'PU' + crypto.randomUUID().slice(0, 9);
  const receive = data.status !== 'ordered';

  let supplierName = data.supplierName || null;
  if (!supplierName && data.supplierId) {
    const { results } = await d1Query(env, 'SELECT name FROM suppliers WHERE id = ?', [String(data.supplierId)]);
    if (results && results[0]) supplierName = results[0].name;
  }

  await d1Run(
    env,
    `INSERT INTO purchases
       (id, supplier_id, supplier_name, date, total, paid, payment_method, status,
        receipt_key, notes, posted_at, created_by, created_by_name, created)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, data.supplierId || null, supplierName,
      data.date || nowIso.slice(0, 10),
      round2(total), round2(paid), data.paymentMethod || null,
      receive ? 'received' : 'ordered',
      data.receiptKey || null, data.notes || null,
      receive ? nowIso : null,
      (auth && auth.staff_id) || null, auth ? actorName(auth) : null, nowIso,
    ]
  );

  for (const l of clean) {
    const lineId = 'PI' + crypto.randomUUID().slice(0, 9);
    await d1Run(
      env,
      `INSERT INTO purchase_items
         (id, purchase_id, inventory_id, qty, unit, unit_cost, total_cost, batch_no, expiry_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [lineId, id, l.inventoryId, l.qty, l.unit, round2(l.unitCostInStockUnit), round2(l.totalCost), l.batchNo, l.expiryDate]
    );

    if (!receive) continue;

    await postMovement(env, auth, {
      inventoryId: l.inventoryId,
      qty: l.qtyInStockUnit,
      type: 'purchase',
      refType: 'purchases',
      refId: id,
      unitCost: l.unitCostInStockUnit,
      reason: supplierName ? `Purchase from ${supplierName}` : 'Purchase',
    });

    // Only perishables get a batch. Asking the kitchen for an expiry date on
    // napkins is how a form stops being filled in truthfully.
    if (l.trackExpiry || l.expiryDate) {
      await d1Run(
        env,
        `INSERT INTO inventory_batches
           (id, inventory_id, purchase_item_id, supplier_id, batch_no, received_at,
            expiry_date, qty_received, qty_remaining, unit, unit_cost, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
        [
          'BT' + crypto.randomUUID().slice(0, 9), l.inventoryId, lineId,
          data.supplierId || null, l.batchNo, nowIso, l.expiryDate,
          l.qtyInStockUnit, l.qtyInStockUnit, l.stockUnit, round2(l.unitCostInStockUnit),
        ]
      );
    }
  }

  await writeAudit(env, auth, {
    action: 'create', entity: 'purchases', entityId: id,
    after: { supplier_id: data.supplierId || null, total: round2(total), lines: clean.length, received: receive },
  });

  return json({
    ok: true, id,
    received: receive,
    lines: clean.length,
    total: round2(total),
    balance: round2(total - paid),
  });
}

/** GET /api/purchases */
async function listPurchases(env, url) {
  const clauses = ['p.voided_at IS NULL'];
  const params = [];
  const supplierId = url.searchParams.get('supplier_id') || url.searchParams.get('supplierId');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const unpaid = url.searchParams.get('unpaid') === 'true';
  if (supplierId) { clauses.push('p.supplier_id = ?'); params.push(supplierId); }
  if (from) { clauses.push('p.date >= ?'); params.push(from); }
  if (to) { clauses.push('p.date <= ?'); params.push(to); }
  if (unpaid) clauses.push('p.total > p.paid');

  const { results } = await d1Query(
    env,
    `SELECT * FROM purchases p WHERE ${clauses.join(' AND ')} ORDER BY p.date DESC LIMIT 300`,
    params
  );
  return json(results || []);
}

/** GET /api/purchases/:id — with its lines. */
async function getPurchase(env, id) {
  const { results } = await d1Query(env, 'SELECT * FROM purchases WHERE id = ?', [id]);
  const purchase = results && results[0];
  if (!purchase) return json({ ok: false, error: 'Purchase not found' }, 404);

  const { results: lines } = await d1Query(
    env,
    `SELECT pi.*, i.name AS item_name, i.unit AS stock_unit
       FROM purchase_items pi LEFT JOIN inventory i ON i.id = pi.inventory_id
      WHERE pi.purchase_id = ?`,
    [id]
  );
  return json({ ok: true, purchase, lines: lines || [] });
}

/** POST /api/purchases/:id/pay — settle some or all of what is owed. */
async function payPurchase(request, env, auth, id) {
  const data = (await readBody(request)) || {};
  const amount = round2(data.amount);
  if (amount <= 0) return json({ ok: false, error: 'Payment amount must be positive' }, 400);

  const { results } = await d1Query(env, 'SELECT * FROM purchases WHERE id = ?', [id]);
  const purchase = results && results[0];
  if (!purchase) return json({ ok: false, error: 'Purchase not found' }, 404);

  const owed = round2(num(purchase.total) - num(purchase.paid));
  if (amount - owed > 0.5) {
    return json({ ok: false, error: `Only ${owed} is outstanding on this purchase`, owed }, 400);
  }

  const paid = round2(num(purchase.paid) + amount);
  await d1Run(env, 'UPDATE purchases SET paid = ?, payment_method = COALESCE(?, payment_method) WHERE id = ?', [
    paid, data.method || null, id,
  ]);

  await writeAudit(env, auth, {
    action: 'update', entity: 'purchases', entityId: id,
    before: { paid: num(purchase.paid) }, after: { paid },
    reason: data.reason || 'Supplier payment',
  });

  return json({ ok: true, paid, balance: round2(num(purchase.total) - paid) });
}

/**
 * DELETE /api/purchases/:id — void and reverse the stock it brought in.
 *
 * Manager-only: this moves both a supplier balance and a shelf quantity.
 */
async function voidPurchase(request, env, auth, id) {
  if (!isManager((auth && (auth.sessionRole || auth.role)) || '')) {
    return json({ ok: false, error: 'Only a manager can void a purchase' }, 403);
  }
  const body = (await readBody(request)) || {};
  if (!body.reason) return json({ ok: false, error: 'A reason is required to void a purchase' }, 400);

  const { results } = await d1Query(env, 'SELECT * FROM purchases WHERE id = ?', [id]);
  const purchase = results && results[0];
  if (!purchase) return json({ ok: false, error: 'Purchase not found' }, 404);
  if (purchase.voided_at) return json({ ok: false, error: 'Already voided' }, 409);

  const { results: moves } = await d1Query(
    env,
    "SELECT * FROM stock_movements WHERE ref_type = 'purchases' AND ref_id = ? AND type = 'purchase'",
    [id]
  );
  for (const mv of moves || []) {
    await postMovement(env, auth, {
      inventoryId: mv.inventory_id,
      qty: -num(mv.qty),
      type: 'void_reversal',
      refType: 'purchases',
      refId: id,
      unitCost: num(mv.unit_cost),
      reason: `Purchase voided: ${body.reason}`,
      // The stock may already have been used. Reversing it can legitimately go
      // negative, and that shortfall is a real thing for a count to settle.
      allowNegative: true,
    });
  }

  const nowIso = new Date().toISOString();
  await d1Run(
    env,
    "UPDATE purchases SET voided_at = ?, voided_by = ?, void_reason = ?, status = 'cancelled' WHERE id = ?",
    [nowIso, actorName(auth), String(body.reason).trim(), id]
  );

  await writeAudit(env, auth, {
    action: 'void', entity: 'purchases', entityId: id,
    before: { status: purchase.status, total: purchase.total },
    after: { status: 'cancelled' },
    reason: String(body.reason).trim(),
  });

  return json({ ok: true, voided: true, reversed: (moves || []).length });
}

/**
 * POST /api/purchases/analyse — the §41 preview, before anything is committed.
 *
 * Answers "I am about to buy 100 kg of coffee — how many cups is that, what
 * does each cup cost me, and what could it take?" Every figure is labelled
 * theoretical; actual revenue only ever comes from completed sales.
 */
async function analyse(request, env) {
  const data = await readBody(request);
  if (!data) return json({ ok: false, error: 'Invalid JSON body' }, 400);

  const { results } = await d1Query(env, 'SELECT * FROM inventory WHERE id = ?', [
    String(data.inventoryId || data.inventory_id),
  ]);
  const item = results && results[0];
  if (!item) return json({ ok: false, error: 'Inventory item not found' }, 404);

  // Which recipe to measure against: the caller's, or the first active recipe
  // that uses this ingredient.
  let line = null;
  let recipe = null;
  const { results: uses } = await d1Query(
    env,
    `SELECT ri.*, r.yield_qty, r.id AS rid, r.menu_item_id
       FROM recipe_items ri JOIN recipes r ON r.id = ri.recipe_id
      WHERE ri.inventory_id = ? AND r.status = 'active'
        ${data.recipeId ? 'AND r.id = ?' : ''}
      LIMIT 1`,
    data.recipeId ? [String(item.id), String(data.recipeId)] : [String(item.id)]
  );
  if (uses && uses[0]) {
    line = uses[0];
    recipe = uses[0];
  }

  let sellingPrice = data.sellingPrice;
  if (sellingPrice === undefined && recipe && recipe.menu_item_id) {
    const { results: mi } = await d1Query(env, 'SELECT price FROM menu_items WHERE id = ?', [recipe.menu_item_id]);
    if (mi && mi[0]) sellingPrice = mi[0].price;
  }

  if (!line) {
    return json({
      ok: true,
      item: { id: item.id, name: item.name, unit: item.unit },
      analysis: null,
      note: 'No active recipe uses this ingredient yet, so servings cannot be projected.',
    });
  }

  return json({
    ok: true,
    item: { id: item.id, name: item.name, unit: item.unit },
    analysis: purchaseAnalysis({
      qty: data.qty,
      unit: data.unit || item.unit,
      totalCost: data.totalCost,
      item,
      line,
      sellingPrice,
      yieldQty: num(recipe.yield_qty, 1),
    }),
  });
}

export async function handlePurchases(pathname, method, url, request, env, auth) {
  const m = method.toUpperCase();

  if (pathname.startsWith('/api/suppliers')) {
    const sub = pathname.replace(/^\/api\/suppliers/, '');
    if (m === 'GET' && sub === '') return listSuppliers(env, url);
    if (m === 'POST' && sub === '') return createSupplier(request, env, auth);
    const one = sub.match(/^\/([^/]+)$/);
    if (m === 'GET' && one) return supplierStatement(env, one[1]);
    // PUT and DELETE fall through to the generic resource handler.
    return null;
  }

  if (pathname.startsWith('/api/purchases')) {
    const sub = pathname.replace(/^\/api\/purchases/, '');
    if (m === 'GET' && sub === '') return listPurchases(env, url);
    if (m === 'POST' && sub === '') return createPurchase(request, env, auth);
    if (m === 'POST' && sub === '/analyse') return analyse(request, env);

    // GET /api/purchases/reorder-suggestions — items below min_level
    if (m === 'GET' && sub === '/reorder-suggestions') {
      const { results } = await d1Query(env, `
        SELECT id, name, unit, stock, min_level, reorder_point, cost_per_unit, preferred_supplier_id
          FROM inventory
         WHERE (active IS NULL OR active = 1)
           AND stock <= COALESCE(reorder_point, min_level, 0)
         ORDER BY (stock / CASE WHEN min_level > 0 THEN min_level ELSE 1 END) ASC
      `).catch(() => ({ results: [] }));

      const suggestions = (results || []).map(i => {
        const minL = num(i.min_level, 10);
        const stock = num(i.stock, 0);
        const suggestedQty = Math.max(minL * 2 - stock, minL);
        const cost = num(i.cost_per_unit, 0);
        return {
          inventoryId: i.id,
          name: i.name,
          unit: i.unit,
          currentStock: stock,
          minLevel: minL,
          suggestedQty,
          estimatedCost: round2(suggestedQty * cost),
          preferredSupplierId: i.preferred_supplier_id || null
        };
      });

      return json({ ok: true, suggestions });
    }

    // POST /api/purchases/generate-po — create a draft purchase order
    if (m === 'POST' && sub === '/generate-po') {
      const data = await readBody(request);
      if (!data || !data.supplierId || !Array.isArray(data.items) || !data.items.length) {
        return json({ ok: false, error: 'supplierId and non-empty items array required' }, 400);
      }
      const nowIso = new Date().toISOString();
      const poId = `PO-${Date.now().toString(36)}`;
      let totalCost = 0;

      for (const line of data.items) {
        const lineId = `POL-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const qty = Math.max(0.1, num(line.qty));
        const unitCost = num(line.unitCost);
        const lineTotal = round2(qty * unitCost);
        totalCost += lineTotal;

        await d1Run(env, `
          INSERT INTO purchase_order_lines (id, po_id, inventory_id, qty_ordered, unit_cost, line_total)
          VALUES (?, ?, ?, ?, ?, ?)
        `, [lineId, poId, line.inventoryId, qty, unitCost, lineTotal]).catch(() => {});
      }

      await d1Run(env, `
        INSERT INTO purchase_orders (id, supplier_id, status, total_cost, notes, created_at, created_by)
        VALUES (?, ?, 'draft', ?, ?, ?, ?)
      `, [poId, data.supplierId, round2(totalCost), data.notes || 'Auto-generated PO', nowIso, actorName(auth)]).catch(() => {});

      await writeAudit(env, auth, { action: 'create', entity: 'purchase_orders', entityId: poId, after: { supplierId: data.supplierId, totalCost } });
      return json({ ok: true, poId, status: 'draft', totalCost: round2(totalCost) });
    }

    const pay = sub.match(/^\/([^/]+)\/pay$/);
    if (m === 'POST' && pay) return payPurchase(request, env, auth, pay[1]);

    const one = sub.match(/^\/([^/]+)$/);
    if (m === 'GET' && one) return getPurchase(env, one[1]);
    if (m === 'DELETE' && one) return voidPurchase(request, env, auth, one[1]);
  }

  return null;
}
