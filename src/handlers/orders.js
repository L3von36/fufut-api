import { d1Query, d1Run, d1Batch, json, readBody } from '../lib/db.js';
import { writeAudit } from '../lib/audit.js';
import { actorName, isManager } from '../auth.js';
import { refreshPaymentStatus } from './payments.js';
import { addToOpenDrawerCash } from '../lib/drawer.js';
import { syncDeliveryToOrderStatus } from './delivery.js';
import { consumeForOrder, reverseOrderConsumption } from '../lib/ledger.js';
import { blocksSeating, ACTIVE_STATUSES } from '../lib/booking.js';
import { venueStatus } from '../lib/venue.js';
import { keysMatch } from '../lib/tablekey.js';
import { getAuthUser } from './session.js';
import {
  normaliseTableId,
  ticketStale,
  DEFAULT_KITCHEN_STALE_HOURS,
  DEFAULT_TABLE_MAX_HOURS,
} from '../lib/staleness.js';

const ACTIVE_LIST = ACTIVE_STATUSES.map((s) => `'${s}'`).join(', ');

/**
 * Order states that mean the food was actually made, and therefore that the
 * ingredients left the shelf. 'ready' is the honest moment; the later states
 * are included so an order that jumps straight to completed — a takeaway paid
 * and handed over in one action — is not missed.
 */
const CONSUME_ON_STATUS = new Set(['ready', 'served', 'completed', 'fulfilled']);
import {
  normaliseLines,
  stampColumnFor,
  isValidItemStatus,
  deriveOrderStatus,
  itemDurations,
  averageByCategory,
  ITEM_FLOW,
  flowIndex,
} from '../lib/timing.js';

/**
 * Order statuses map onto line statuses. "fulfilled" is the order-level word
 * this codebase already uses for a completed order; on a line it means the dish
 * reached the guest, which is "served".
 */
const ORDER_TO_ITEM_STATUS = {
  new: 'new',
  preparing: 'preparing',
  ready: 'ready',
  served: 'served',
  fulfilled: 'served',
  completed: 'served',
};

function mapOrderRow(o) {
  const tn = o.table_id || o.table_number || o.tableNum || null;
  return Object.assign({}, o, { tableNum: tn, table_number: tn });
}

/**
 * Category per line, resolved once per order rather than per line.
 *
 * menu_items stores category_id, so the readable name needs the join. It is
 * copied onto the order line at write time instead of being looked up in
 * reports later, because a dish can be recategorised or deleted and the timing
 * history still has to describe what was actually sold that day.
 */
async function categoryLookup(env) {
  try {
    const { results } = await d1Query(
      env,
      `SELECT m.id AS id, m.name AS name, c.name AS category
         FROM menu_items m LEFT JOIN categories c ON c.id = m.category_id`
    );
    const byId = new Map();
    const byName = new Map();
    for (const row of results || []) {
      if (!row.category) continue;
      if (row.id) byId.set(String(row.id), row.category);
      if (row.name) byName.set(String(row.name).toLowerCase(), row.category);
    }
    return { byId, byName };
  } catch {
    // A missing category must not stop an order being taken.
    return { byId: new Map(), byName: new Map() };
  }
}

function resolveCategory(line, lookup) {
  if (line.category) return line.category;
  if (line.menuItemId && lookup.byId.has(String(line.menuItemId))) {
    return lookup.byId.get(String(line.menuItemId));
  }
  return lookup.byName.get(line.name.toLowerCase()) || '';
}

/**
 * Turn a `table_key` into a table, or refuse.
 *
 * Returns `{ table: null }` when no key was sent — that is not an error, it is
 * every order the system takes today.
 *
 * The refusals are deliberately vague to the caller ("that code is not valid")
 * and specific in the code, because a guest cannot act on the difference
 * between a wrong key and an unknown table, and an attacker should not learn
 * which tables exist.
 */
async function resolveTableKey(env, data) {
  const key = data && (data.table_key || data.tableKey || data.k);
  if (!key) return { table: null };

  const wanted = normaliseTableId(data.tableNum || data.table_number || data.table_id || data.t);
  if (!wanted) return { error: 'That table code is not valid.' };

  let results;
  try {
    ({ results } = await d1Query(env, 'SELECT * FROM tables WHERE id = ? OR number = ?', [
      String(wanted),
      Number(wanted) || -1,
    ]));
  } catch {
    // The column arrives by migration 015. Until it is applied, a key cannot
    // be checked, and accepting one unchecked would be worse than refusing.
    return { error: 'Table ordering is not set up yet.' };
  }

  const table = results && results[0];
  if (!table || !table.qr_key || !keysMatch(key, table.qr_key)) {
    return { error: 'That table code is not valid.' };
  }
  return { table };
}

/**
 * Look up a table row by id or number, regardless of who is asking.
 *
 * Used by the dine-in auto-seat path (Finding 1): a non-QR order carries the
 * table only as a string, so the row has to be resolved before the conditional
 * UPDATE can claim it. Returns null when the table is unknown — a number that
 * does not exist is left alone rather than rejected, because the order is still
 * a valid order without a floor plan slot.
 */
async function resolveTableRow(env, tableId) {
  if (!tableId) return null;
  try {
    const { results } = await d1Query(
      env,
      'SELECT * FROM tables WHERE id = ? OR number = ?',
      [String(tableId), Number(tableId) || -1]
    );
    return (results && results[0]) || null;
  } catch {
    return null;
  }
}

/**
 * The menu, keyed the two ways an order line can name a dish.
 *
 * Guests reach the cloud with lines that name a dish by menu id (what the
 * website cart sends) or — for the oldest payloads — by name alone. Both
 * spellings must resolve to the same row the till prices from, or the check
 * below cannot tell a menu item from an invented one.
 *
 * Returns null when the menu cannot be read or holds nothing: both mean the
 * caller has no honest price to charge against.
 */
async function guestMenu(env) {
  try {
    const { results } = await d1Query(
      env,
      'SELECT id, name, price, available FROM menu_items'
    );
    const rows = results || [];
    if (!rows.length) return null;
    const byId = new Map();
    const byName = new Map();
    for (const m of rows) {
      if (m.id != null && !byId.has(String(m.id))) byId.set(String(m.id), m);
      const nm = String(m.name || '').trim().toLowerCase();
      if (nm && !byName.has(nm)) byName.set(nm, m);
    }
    return { byId, byName };
  } catch {
    return null;
  }
}

/**
 * Price an anonymous order from the menu, not from the request.
 *
 * POST /api/orders is public on purpose — it is how the website and the QR
 * table codes take an order — but until now every figure on the receipt came
 * off the wire: the per-line price, the subtotal, the discount, the total,
 * the status. A guest who edited the request (or wrote their own) could buy
 * two espressos for one birr and mark the order completed and paid in the
 * same POST, and the books would record it as settled cash. Confirmed live
 * on 2026-08-27: three probe orders (Ocff9d5a, O16e8cab, O6d9a999) landed
 * at attacker-chosen prices, one of them "paid".
 *
 * The fix is not to close the route — the website has no other way in — but
 * to stop trusting the arithmetic of a stranger. A guest's order is priced
 * here from menu_items: known dishes are repriced to what the menu says and
 * renamed to the menu's spelling, unknown dishes are refused (the website
 * can only ever send real ones), a discount is dropped (a guest cannot
 * authorise one), every optional addition is clamped at zero or above, and
 * the total is recomputed from the result. Status is forced to 'new' —
 * served, completed and voided are the shop's words to say, not the
 * requester's — and payment fields are stripped, because the only anonymous
 * payment rows ever written were probes verified by nobody.
 *
 * Signed-in staff are exempt: the till computes its own totals, including
 * discounts and service charge a manager has approved, and every write it
 * makes is attributed and audited.
 *
 * Mutates `data` in place and returns `{ repriced }` — true when any line's
 * price had to be corrected — or `{ status, reason, error }` for the caller
 * to return as a refusal.
 */
async function priceGuestOrder(env, data) {
  const lines = normaliseLines(data.orderItems || data.order_items || data.items, 0);
  if (!lines.length) {
    return {
      status: 400,
      reason: 'no-items',
      error: 'Your order is empty. Please add something from the menu and try again.',
    };
  }

  const menu = await guestMenu(env);
  // Without the menu there is no honest price to charge a guest — and no
  // guest with a cart, since the website renders its prices from this same
  // table. Refusing here is telling the truth rather than taking a
  // stranger's word for what the food costs.
  if (!menu) {
    return {
      status: 503,
      reason: 'menu-unavailable',
      error: 'The menu is not available right now. Please try again shortly.',
    };
  }

  const unknown = [];
  const unavailable = [];
  let repriced = false;
  let subtotal = 0;

  for (const line of lines) {
    const hit =
      (line.menuItemId && menu.byId.get(String(line.menuItemId))) ||
      menu.byName.get(line.name.trim().toLowerCase()) ||
      null;
    if (!hit) {
      unknown.push(line.name);
      continue;
    }
    if (hit.available === false || hit.available === 0) {
      unavailable.push(String(hit.name || line.name));
      continue;
    }
    const menuPrice = Number(hit.price) || 0;
    if (Math.abs(menuPrice - Number(line.unitPrice)) > 0.005) repriced = true;
    line.name = String(hit.name || line.name);
    line.unitPrice = menuPrice;
    subtotal += menuPrice * line.qty;
  }

  if (unknown.length) {
    return {
      status: 400,
      reason: 'unknown-item',
      error: `"${unknown[0]}" is not on the menu. Please refresh the menu and try again.`,
    };
  }
  if (unavailable.length) {
    return {
      status: 400,
      reason: 'unavailable-item',
      error: `${unavailable[0]} is unavailable right now. Please remove it and try again.`,
    };
  }

  // A guest may round up — a tip, a delivery fee the site quotes — but never
  // down: every optional addition is clamped at zero, and the discount is
  // dropped entirely.
  const tip = Math.max(0, round2(data.tip));
  const serviceCharge = Math.max(0, round2(data.serviceCharge));
  const tax = Math.max(0, round2(data.tax));
  const deliveryFee = Math.max(0, round2(data.deliveryFee));
  const total = round2(subtotal + tip + serviceCharge + tax + deliveryFee);

  // The corrected lines go back in the client's own shape — id, name, qty,
  // price — so the summary column and the per-line tracking rows both carry
  // the menu's figures. normaliseLines reads `price` off this shape again
  // downstream, which is why the normalised rows must not be passed through.
  data.items = lines.map((l) => ({
    id: l.menuItemId || undefined,
    name: l.name,
    qty: l.qty,
    price: l.unitPrice,
  }));
  delete data.orderItems;
  delete data.order_items;
  data.subtotal = round2(subtotal);
  data.total = total;
  data.discount = 0;
  data.discountType = null;
  data.discountReason = null;
  data.tip = tip;
  data.serviceCharge = serviceCharge;
  data.tax = tax;
  data.deliveryFee = deliveryFee;
  // A guest's order starts its life the way every guest order starts: new
  // and unpaid. Status and settlement are the shop's to set, not the
  // requester's — the live probe had one arrive "completed" and "paid".
  data.status = 'new';
  delete data.payment;
  delete data.paymentBreakdown;

  return { repriced };
}

/**
 * Write one tracking row per order line.
 *
 * Deliberately never throws: an order the kitchen cannot time is still an order
 * the guest is waiting for, and taking ordering offline to protect a metric is
 * the wrong trade. Failures come back as a warning on the response instead of
 * disappearing.
 *
 * `lineOffset` lets a new round continue an open ticket's numbering instead of
 * colliding with the lines already on it.
 */
async function insertOrderItems(env, orderId, items, createdIso, lineOffset = 0) {
  const lines = normaliseLines(items, lineOffset);
  if (!lines.length) return { inserted: 0, warning: null };

  try {
    const lookup = await categoryLookup(env);
    const cols = await orderItemColumns(env);
    const canCourse = cols.includes('course');

    const statements = lines.map((line) => {
      const columns = [
        'id', 'order_id', 'line_no', 'menu_item_id', 'name', 'category', 'qty',
        'unit_price', 'modifiers', 'notes', 'status', 'created_at',
      ];
      if (canCourse) columns.push('course');
      const placeholders = columns.map(() => '?').join(', ');
      const params = [
        'OI' + crypto.randomUUID().slice(0, 10),
        orderId,
        line.lineNo,
        line.menuItemId || null,
        line.name,
        resolveCategory(line, lookup),
        line.qty,
        line.unitPrice,
        line.modifiers || null,
        line.notes || null,
        'new',
        createdIso,
      ];
      if (canCourse) params.push(line.course || 'main');
      return {
        sql: `INSERT INTO order_items (${columns.join(', ')}) VALUES (${placeholders})`,
        params,
      };
    });
    await d1Batch(env, statements);
    return { inserted: lines.length, warning: null };
  } catch (e) {
    return { inserted: 0, warning: `Order saved, but per-item timing was not recorded: ${String(e.message || e)}` };
  }
}

/**
 * Columns the order_items table actually has, resolved once per isolate.
 *
 * Same rationale as orderColumns below: the new `course` column arrives by
 * migration, so writing it unconditionally would take line tracking offline for
 * the window between deploying this Worker and applying the migration. Filtering
 * against PRAGMA means the deploy order stops mattering here too.
 */
let ITEM_COLUMNS = null;
async function orderItemColumns(env) {
  if (ITEM_COLUMNS) return ITEM_COLUMNS;
  const { results } = await d1Query(env, "PRAGMA table_info(order_items)");
  ITEM_COLUMNS = (results || []).map((c) => c.name);
  return ITEM_COLUMNS;
}

/** Test seam: forget the cached order_items schema. */
function resetOrderItemColumns() {
  ITEM_COLUMNS = null;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Columns the orders table actually has, resolved once per isolate.
 *
 * Migration 005 adds seventeen columns. Writing them unconditionally would take
 * ordering offline for the window between deploying this Worker and applying
 * the migration, and one try/catch per column — the pattern the `notes` column
 * used — does not scale to seventeen. Filtering against PRAGMA instead means
 * the deploy order stops mattering, which is the property that was actually
 * wanted both times.
 *
 * Cached because the schema cannot change under a running isolate; a cold start
 * after the migration picks up the new columns.
 */
let ORDER_COLUMNS = null;
async function orderColumns(env) {
  if (ORDER_COLUMNS) return ORDER_COLUMNS;
  const { results } = await d1Query(env, "PRAGMA table_info(orders)");
  ORDER_COLUMNS = (results || []).map((c) => c.name);
  return ORDER_COLUMNS;
}

/**
 * Checks with money still owed on them.
 *
 * "Open" is a question about money, not about food. An order that has been
 * served is exactly when the bill falls due, so order status is deliberately
 * not a filter here — the floor plan already made that mistake, dropping a tab
 * from its badge the moment the food was marked delivered. Only cancelling or
 * voiding stops a check being owed, and only settling stops it being open.
 * 'overpaid' is settled: the guest is owed change, not the shop.
 *
 * Oldest first, because the check that has been open longest is the one most
 * likely to walk.
 */
async function listOpenChecks(env) {
  const cols = await orderColumns(env);
  const where = ["COALESCE(status,'') <> 'cancelled'"];
  if (cols.includes('voided_at')) where.push('voided_at IS NULL');
  // Filtered against the live schema for the same reason the writes are: the
  // payment columns arrived in migration 005, and a SELECT naming a column the
  // table does not have fails outright rather than degrading.
  if (cols.includes('payment_status')) {
    where.push("(payment_status IS NULL OR payment_status IN ('unpaid','partial'))");
  } else {
    where.push("COALESCE(payment,'') <> 'paid'");
  }
  const { results } = await d1Query(
    env,
    `SELECT * FROM orders WHERE ${where.join(' AND ')} ORDER BY created ASC`
  );
  return results || [];
}

/**
 * Open checks belonging to one member of staff.
 *
 * Ownership is `created_by`, the person who took the order. That is who is
 * asked about it at the end of a shift, and it is stamped by the server from
 * the session rather than sent by the client.
 */
async function openChecksForStaff(env, staffId) {
  if (!staffId) return [];
  const open = await listOpenChecks(env);
  return open.filter((o) => String(o.created_by || '') === String(staffId));
}

/** Open checks still sitting against one table. */
async function openChecksForTable(env, tableNumber, excludeOrderId) {
  const open = await listOpenChecks(env);
  return open.filter(
    (o) => String(o.table_id || '') === String(tableNumber) && o.id !== excludeOrderId
  );
}

/** Test seam: forget the cached schema. */
function resetOrderColumns() {
  ORDER_COLUMNS = null;
}

/**
 * Turn the POS's `paymentBreakdown` into real payment rows.
 *
 * The POS has always sent this array — `[{method, amount}, …]` for a split bill,
 * a single entry otherwise. The API collapsed it to the string "cash+telebirr"
 * on `orders.payment`, so the amount per method was lost at the door and
 * per-method revenue could not be reported.
 *
 * `orders.payment` is still written, unchanged, because the receipt and several
 * screens read it. It is now a summary of these rows.
 *
 * Never throws: a guest who has paid must not be told their order failed.
 */
async function recordSubmittedPayments(env, auth, orderId, data) {
  const breakdown = Array.isArray(data.paymentBreakdown) ? data.paymentBreakdown : [];
  // An order can be created before it is paid — a waiter sending food to the
  // kitchen, a delivery going out on account. No breakdown simply means no
  // money has changed hands yet.
  if (!breakdown.length) return { inserted: 0, warning: null };

  try {
    // Idempotency guard for settlement: an open tab is created empty and paid
    // later with a PUT, and a retried PUT (a flaky tablet, the offline queue)
    // must not post the same cash twice. If rows already exist the money is
    // already on the books — this call is the duplicate.
    const { results: existing } = await d1Query(
      env,
      "SELECT id FROM payments WHERE order_id = ? AND status <> 'rejected'",
      [orderId]
    );
    if (existing && existing.length) return { inserted: 0, warning: null };

    const nowIso = new Date().toISOString();
    const statements = breakdown
      .filter((p) => p && Number(p.amount))
      .map((p) => {
        const method = String(p.method || "cash").toLowerCase();
        // A transfer is only settled once somebody has seen the evidence.
        const status = ["telebirr", "cbe", "bank"].includes(method) ? "recorded" : "verified";
        return {
          sql: `INSERT INTO payments
             (id, order_id, method, amount, tendered, change_due, reference, evidence_key,
              status, collected_by, collected_by_name, verified_by, verified_by_name,
              verified_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [
          "PM" + crypto.randomUUID().slice(0, 10),
          orderId,
          method,
          round2(p.amount),
          p.tendered !== undefined ? round2(p.tendered) : null,
          p.change !== undefined ? round2(p.change) : null,
          p.reference || null,
          p.evidenceKey || null,
          status,
          (auth && auth.staff_id) || null,
          auth ? actorName(auth) : null,
          status === "verified" ? (auth && auth.staff_id) || null : null,
          status === "verified" ? (auth ? actorName(auth) : null) : null,
          status === "verified" ? nowIso : null,
          nowIso
          ],
        };
      });

    if (!statements.length) return { inserted: 0, warning: null };
    await d1Batch(env, statements);
    await refreshPaymentStatus(env, orderId);
    // Cash from this settlement belongs in the open till's tally, so the
    // Z-count's "expected" figure includes it. Transfer legs never enter the
    // drawer and are skipped. Guarded by the idempotency check above: a retried
    // PUT returns before reaching here, so the same cash cannot count twice.
    const cashPortion = statements.reduce(
      (sum, s) => (String(s.params[2]).toLowerCase() === 'cash' ? sum + Number(s.params[3]) : sum),
      0
    );
    if (cashPortion > 0) await addToOpenDrawerCash(env, cashPortion);
    return { inserted: statements.length, warning: null };
  } catch (e) {
    return {
      inserted: 0,
      warning: `Order saved, but the payment record was not written: ${String(e.message || e)}`,
    };
  }
}

/**
 * Record the tip against the person who earned it.
 *
 * `orders.tip` says what was added to the bill; this says who is owed it, which
 * is the question the manager actually asks. The tip is attributed to whoever
 * took the order, which is right for a waiter closing their own table — a
 * delivery tip is reassigned to the driver when the round is settled.
 */
async function recordSubmittedTip(env, auth, orderId, data, tip, orderType) {
  if (!tip || tip <= 0) return { inserted: 0, warning: null };
  try {
    const nowIso = new Date().toISOString();
    let staffName = auth ? actorName(auth) : null;
    // Idempotency guard, mirroring recordSubmittedPayments: an open tab is
    // settled with a PUT that can be retried (flaky tablet, offline queue), and
    // a retry must not record the same tip twice. One tip row per order is the
    // rule — the order itself already carries the tip figure.
    const { results: existing } = await d1Query(
      env,
      "SELECT id FROM tips WHERE order_id = ?",
      [orderId]
    );
    if (existing && existing.length) return { inserted: 0, warning: null };
    await d1Run(
      env,
      `INSERT INTO tips
         (id, order_id, staff_id, staff_name, amount, method, status, source, date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'recorded', ?, ?, ?)`,
      [
        "TP" + crypto.randomUUID().slice(0, 10),
        orderId,
        (auth && auth.staff_id) || null,
        staffName,
        tip,
        data.payment ? String(data.payment).split("+")[0].toLowerCase() : null,
        orderType || null,
        nowIso.slice(0, 10),
        nowIso,
      ]
    );
    return { inserted: 1, warning: null };
  } catch (e) {
    return {
      inserted: 0,
      warning: `Order saved, but the tip was not recorded: ${String(e.message || e)}`,
    };
  }
}

/**
 * Create the delivery job that a delivery order implies.
 *
 * This is the fix for the gap that made delivery non-functional: `orders.type`
 * could be 'delivery' and the `delivery` table existed with every column it
 * needed, but nothing ever wrote a row. A delivery order taken at the till
 * never appeared on the Delivery screen, so there was no way to assign a
 * driver, no address in front of anyone, and no record of the money coming
 * back.
 *
 * One order produces one delivery job, keyed by the order id, so a retried
 * submission cannot put the same food on the road twice.
 */
async function createDeliveryJob(env, auth, orderId, data, orderType) {
  if (orderType !== "delivery") return { id: null, warning: null };
  try {
    const { results } = await d1Query(env, "SELECT id FROM delivery WHERE orderId = ?", [orderId]);
    if (results && results.length) return { id: results[0].id, warning: null };

    const nowIso = new Date().toISOString();
    const id = "DL" + crypto.randomUUID().slice(0, 7);
    await d1Run(
      env,
      `INSERT INTO delivery
         (id, orderId, customer, address, phone, notes, status, fee, payment_status, created, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'new', ?, 'unpaid', ?, ?)`,
      [
        id,
        orderId,
        data.customer || data.name || "Walk-in",
        data.address || data.deliveryAddress || "",
        data.customerPhone || data.phone || "",
        data.deliveryNotes || data.notes || "",
        round2(data.deliveryFee),
        nowIso,
        nowIso,
      ]
    );
    return { id, warning: null };
  } catch (e) {
    return {
      id: null,
      warning: `Order saved, but the delivery job was not created: ${String(e.message || e)}`,
    };
  }
}

/**
 * Move a check to another table.
 *
 * This exists because of what staff do without it. A guest changes seats, or
 * the order went on the wrong table, and the only tool available is to clear
 * the table — which drops the tab off the floor plan while the money is still
 * owed. Giving people the operation is how you stop the workaround; refusing
 * the workaround without providing the operation just moves the damage.
 *
 * The destination is subject to the same exclusivity as seating anywhere else:
 * a table with a party on it, or one inside a booking's window, is refused
 * unless a manager decides otherwise.
 */
async function transferCheck(orderId, request, env, auth) {
  const data = await readBody(request);
  if (!data) return json({ ok: false, error: "Invalid JSON body" }, 400);

  const target = String(
    data.tableNumber ?? data.table_number ?? data.tableNum ?? ""
  ).trim();
  if (!target) return json({ ok: false, error: "tableNumber is required" }, 400);

  const { results: orderRows } = await d1Query(env, "SELECT * FROM orders WHERE id = ?", [orderId]);
  const order = (orderRows || [])[0];
  if (!order) return json({ ok: false, error: "Order not found" }, 404);
  if (order.voided_at) {
    return json({ ok: false, error: "This check has been voided and cannot be moved." }, 409);
  }
  if (String(order.payment_status || "") === "paid") {
    return json({ ok: false, error: "This check is already settled." }, 409);
  }

  const from = String(order.table_id || "");
  // Moving a check to where it already is should not disturb either table.
  if (from === target) return json({ ok: true, moved: false, from, to: target });

  const { results: destRows } = await d1Query(env, "SELECT * FROM tables WHERE number = ?", [target]);
  const dest = (destRows || [])[0];
  if (!dest) return json({ ok: false, error: `Table ${target} does not exist.` }, 404);

  const manager = isManager((auth && (auth.sessionRole || auth.role)) || "");
  const nowMs = Date.now();

  if (String(dest.status || "").toLowerCase() === "occupied" && !manager) {
    return json(
      {
        ok: false,
        error: `Table ${target} already has a party seated. Pick an empty table or ask a manager.`,
        occupiedBy: { server: dest.server || null, guests: dest.guests || 0, seatedAt: dest.seated_at || null },
      },
      409
    );
  }

  const { results: bookings } = await d1Query(
    env,
    `SELECT id, name, guests, status, start_at, end_at, released_at, no_show_at
       FROM reservations
      WHERE table_id = ?
        AND status IN (${ACTIVE_LIST})
        AND released_at IS NULL
        AND no_show_at IS NULL
        AND start_at IS NOT NULL AND end_at IS NOT NULL`,
    [dest.id]
  );
  const hold = (bookings || []).find((r) => blocksSeating(r, nowMs));
  if (hold && !manager) {
    return json(
      {
        ok: false,
        error: `Table ${target} is reserved. A manager must release it before a check can be moved there.`,
        reservation: { id: hold.id, name: hold.name, guests: hold.guests, startAt: hold.start_at, endAt: hold.end_at },
      },
      409
    );
  }

  const nowIso = new Date().toISOString();
  const { results: srcRows } = await d1Query(env, "SELECT * FROM tables WHERE number = ?", [from]);
  const src = (srcRows || [])[0] || null;

  await d1Run(env, "UPDATE orders SET table_id = ?, updated_at = ? WHERE id = ?", [target, nowIso, orderId]);

  // The party moves with the check: guests and server come across, and the
  // seating clock is only started if the destination was not already running
  // one, so a manager merging onto a busy table does not reset its timer.
  await d1Run(
    env,
    `UPDATE tables
        SET status = 'occupied',
            seated_at = CASE WHEN seated_at IS NULL OR TRIM(seated_at) = '' THEN ? ELSE seated_at END,
            guests = ?,
            server = ?
      WHERE id = ?`,
    [nowIso, (src && src.guests) || dest.guests || 0, (src && src.server) || dest.server || "", dest.id]
  );

  // Free the table they left, but only once nothing is owed on it. Another
  // party's tab may still be sitting there.
  let sourceFreed = false;
  if (src) {
    const remaining = await openChecksForTable(env, from, orderId);
    if (!remaining.length) {
      await d1Run(
        env,
        "UPDATE tables SET status = 'available', seated_at = '', guests = 0, server = '' WHERE id = ?",
        [src.id]
      );
      sourceFreed = true;
    }
  }

  await writeAudit(env, auth, {
    action: "update",
    entity: "orders",
    entityId: orderId,
    before: { table_id: from },
    after: { table_id: target, source_table_freed: sourceFreed },
  });

  return json({ ok: true, moved: true, from, to: target, sourceFreed });
}

/**
 * How long before a table and a kitchen ticket are treated as abandoned.
 *
 * Settings rather than constants: a cafe that turns tables in forty minutes and
 * a restaurant that seats for two hours do not want the same number, and the
 * person who knows which is not the one deploying Workers.
 */
async function loadStaleHours(env) {
  const fallback = { table: DEFAULT_TABLE_MAX_HOURS, kitchen: DEFAULT_KITCHEN_STALE_HOURS };
  try {
    const { results } = await d1Query(
      env,
      "SELECT key, value FROM settings WHERE key IN ('tables.max_occupied_hours', 'kitchen.stale_hours')"
    );
    const map = {};
    for (const r of results || []) map[r.key] = Number(String(r.value).replace(/"/g, ''));
    return {
      table: Number.isFinite(map['tables.max_occupied_hours']) && map['tables.max_occupied_hours'] > 0
        ? map['tables.max_occupied_hours'] : fallback.table,
      kitchen: Number.isFinite(map['kitchen.stale_hours']) && map['kitchen.stale_hours'] > 0
        ? map['kitchen.stale_hours'] : fallback.kitchen,
    };
  } catch {
    // Before migration 007 there is no settings table. Defaults are correct.
    return fallback;
  }
}

async function handleOrders(pathname, method, url, request, env, auth) {
  const m = method.toUpperCase();
  const sub = pathname.replace(/^\/api\/orders/, "");
  if (m === "GET" && sub === "") {
    const params = url && url.searchParams ? url.searchParams : null;
    const tableFilter = params ? params.get("table_number") : null;
    const openOnly = params ? ['1', 'true', 'yes'].includes(String(params.get("open") || '').toLowerCase()) : false;
    let rows;
    if (openOnly) {
      rows = await listOpenChecks(env);
    } else if (tableFilter) {
      const { results } = await d1Query(env, "SELECT * FROM orders WHERE table_id = ? ORDER BY created DESC", [String(tableFilter)]);
      rows = results || [];
    } else {
      const { results } = await d1Query(env, "SELECT * FROM orders ORDER BY created DESC");
      rows = results || [];
    }
    return json(rows.map(mapOrderRow));
  }
  if (m === "POST" && sub === "") {
    /**
     * An order nobody can cook is worse than an order not taken.
     *
     * This route is anonymous — it is how the website orders — so when the
     * venue has gone quiet the cloud accepts orders into a database the kitchen
     * cannot see. The customer pays and waits for food that was never started.
     * Refusing is the kinder failure, and it is the decision recorded in the
     * design doc.
     *
     * Only anonymous orders. A signed-in member of staff reaching the cloud is
     * the fallback when the box is down but the line is up, and closing that
     * would take the till offline at precisely the wrong moment.
     */
    // `auth` is null here even for a signed-in waiter: this route is in PUBLIC,
    // so the gate returns before it ever looks for a session. Resolving it
    // explicitly is the only way to tell a customer from a member of staff,
    // and getting that wrong would refuse the till instead of the website.
    const actor = auth || (await getAuthUser(request, env));

    if (!actor) {
      const venue = await venueStatus(env);
      if (!venue.online) {
        return json(
          {
            ok: false,
            error: 'Online ordering is closed at the moment. Please call the shop or try again shortly.',
            reason: 'venue-offline',
            since: venue.lastSeen,
          },
          503
        );
      }
    }

    const data = await readBody(request);
    if (!data) return json({ ok: false, error: "Invalid JSON body" }, 400);

    /**
     * An order placed by a guest from the code on their table.
     *
     * Present only when the request carries a `table_key`, so nothing that
     * exists today changes: the website's own form, and every staff-entered
     * order, take the path below untouched.
     *
     * What the key buys is that the table is *established* rather than
     * *claimed*. Without it a stranger can post an order naming any table;
     * with it, the order can only attach to the table whose printed card they
     * are sitting in front of.
     */
    const qr = await resolveTableKey(env, data);
    if (qr.error) return json({ ok: false, error: qr.error, reason: 'bad-table-code' }, 403);

    // A stranger's arithmetic is not a price. Guests are repriced from the
    // menu before anything is written; a signed-in member of staff keeps
    // the totals the till computed — discounts, service charge and all —
    // and stays attributed and audited.
    let guestRepriced = false;
    if (!actor) {
      const priced = await priceGuestOrder(env, data);
      if (priced.error) {
        return json({ ok: false, error: priced.error, reason: priced.reason }, priced.status);
      }
      guestRepriced = priced.repriced;
    }

    try {
      // Staff may name the order (the till's offline queue keys on it); a
      // guest cannot — a client-chosen id can only collide or impersonate.
      const id = (actor && data.id) || "O" + crypto.randomUUID().slice(0, 7);
      const items = typeof data.items === "string" ? data.items : JSON.stringify(data.items || []);
      // Normalised on the way in: "7.0" and "07" are the same table as "7",
      // and every screen compares this as a string.
      const tableId = normaliseTableId(data.tableNum || data.table_number || data.table_id);
      const notes = typeof data.notes === "string" ? data.notes.trim() : "";
      const nowIso = new Date().toISOString();
      const orderType = data.order_type || data.type || null;
      const tip = round2(data.tip);

      // Every field the POS has always sent. Before this, ten of them were
      // written and the rest — subtotal, discount, discount_reason, tip — were
      // read off the wire and dropped, so a tip taken on the floor left no
      // trace anywhere in the system.
      //
      // The write is filtered against the columns the table actually has
      // (see orderColumns), which replaces the previous insert-and-retry: with
      // this many new columns, one try/catch per column would be unreadable,
      // and the filter keeps ordering working either side of migration 005.
      /**
       * A verified code overrides whatever the body claimed.
       *
       * The guest's phone sends the table it read off the card, but the key is
       * what proves it. Taking the table from the row we just authenticated
       * means a tampered payload cannot name one table and be filed under
       * another, and it forces dine-in: a code on table 4 is not a delivery.
       */
      const row = {
        id,
        items,
        total: round2(data.total),
        payment: data.payment || null,
        type: qr.table ? 'dine-in' : orderType,
        /* Normalised like every other reference. Filing a QR order under
         * the raw `tables.id` put it under "Table 6" while the POS filed the
         * same table under "6", and the floor plan compares these as strings —
         * so the guest's order existed and no screen showed it. The number
         * column is the reliable half of the row; the id is free text. */
        table_id: qr.table
          ? normaliseTableId(qr.table.number ?? qr.table.id)
          : tableId,
        source: qr.table ? 'qr' : null,
        customer: data.name || data.customer || null,
        status: data.status || "new",
        email: data.email || "",
        notes,
        subtotal: data.subtotal !== undefined ? round2(data.subtotal) : round2(data.total),
        discount: round2(data.discount),
        discount_type: data.discountType || data.discount_type || null,
        discount_reason: data.discountReason || data.discount_reason || null,
        tip,
        tip_type: data.tipType || data.tip_type || null,
        service_charge: round2(data.serviceCharge),
        tax: round2(data.tax),
        delivery_fee: round2(data.deliveryFee),
        customer_phone: data.customerPhone || data.phone || null,
        // A takeaway is waiting at the counter from the moment it is taken; a
        // dine-in or delivery order has no pickup stage at all.
        pickup_status: orderType === "takeaway" ? "awaiting" : null,
        payment_status: "unpaid",
        created_by: (auth && auth.staff_id) || null,
        created_by_name: auth ? actorName(auth) : null,
      };

      const cols = await orderColumns(env);
      const writable = Object.keys(row).filter((c) => cols.includes(c));
      await d1Run(
        env,
        `INSERT INTO orders (${writable.join(", ")}) VALUES (${writable.map(() => "?").join(", ")})`,
        writable.map((c) => row[c])
      );

      // orderItems is the structured cart the POS already sends alongside the
      // human-readable items string; it is preferred because it carries the
      // menu id, the unit price and the modifiers. Falling back to items keeps
      // tracking working for any client that only posts the summary.
      /**
       * The first scan seats the table.
       *
       * The alternative — refusing until a waiter has seated it — is right for
       * a room where staff walk guests to their table, and wrong for one where
       * people sit themselves down: the guest's first experience of the new
       * system would be an error. Seating on scan also makes the floor plan
       * more accurate rather than less, since it records the moment somebody
       * actually sat down.
       *
       * The conditional UPDATE is the same atomic claim the POS uses, so two
       * guests scanning at once cannot both seat the table, and a table already
       * occupied is simply left alone — a second round from the same table must
       * not reset who is sitting there.
       */
      if (qr.table) {
        try {
          await d1Run(
            env,
            "UPDATE tables SET status = 'occupied', seated_at = ? WHERE id = ? AND status <> 'occupied'",
            [nowIso, String(qr.table.id)]
          );
        } catch {
          // A table that will not seat must never cost the guest their order.
        }
      } else if (tableId && (row.type === 'dine-in' || (row.type === null && tableId))) {
        // Finding 1 (B+ sim): a dine-in order with a table_id but no QR key
        // used to leave the floor plan out of sync — the order carried the
        // table but its status stayed 'available' until a separate PUT. The
        // POS UI chained the writes; an API integrator (a kiosk, a delivery
        // bridge, a third-party reservation system) did not, so the floor
        // plan and the orders list drifted. The QR path above already seats
        // its table; this seats every other dine-in the same way.
        try {
          const seatTarget = await resolveTableRow(env, tableId);
          if (seatTarget && String(seatTarget.status || '').toLowerCase() !== 'occupied') {
            await d1Run(
              env,
              "UPDATE tables SET status = 'occupied', seated_at = ? WHERE id = ? AND status <> 'occupied'",
              [nowIso, String(seatTarget.id)]
            );
          }
        } catch {
          // Same fail-open rule as the QR path: a table that will not seat
          // must never cost the guest their order.
        }
      }

      const tracking = await insertOrderItems(
        env,
        id,
        data.orderItems || data.order_items || data.items,
        nowIso
      );

      // Payments, the tip and the delivery job are all consequences of the
      // order existing, and none of them may take ordering offline if they
      // fail — same reasoning as insertOrderItems above. Each returns a warning
      // rather than throwing.
      const followUps = [];
      // A guest cannot settle their own order: the only anonymous payment
      // and tip rows ever written were probes, verified by and attributed to
      // nobody. Settlement happens in store, signed in.
      const payments = actor
        ? await recordSubmittedPayments(env, auth, id, data)
        : { inserted: 0, warning: null };
      if (payments.warning) followUps.push(payments.warning);

      const tipResult = actor
        ? await recordSubmittedTip(env, auth, id, data, tip, orderType)
        : { inserted: 0, warning: null };
      if (tipResult.warning) followUps.push(tipResult.warning);

      const delivery = await createDeliveryJob(env, auth, id, data, orderType);
      if (delivery.warning) followUps.push(delivery.warning);

      await writeAudit(env, auth, {
        action: "create",
        entity: "orders",
        entityId: id,
        after: {
          type: orderType,
          table_id: tableId,
          total: row.total,
          subtotal: row.subtotal,
          discount: row.discount,
          tip: row.tip,
          // Lets the books tell a stale cached menu (repriced once, honest
          // guest) from a probing campaign (repriced every time).
          ...(guestRepriced ? { guest_repriced: true } : {}),
        },
      });

      // Finding 5 (B+ sim): a reservation marked "seated" on the same table
      // carries no join key to the order that fulfilled it, so nightly
      // "which reservations converted to revenue" reporting had no way to
      // correlate the two. Link them here: when an order is created on a
      // table that has a seated reservation with no order_id yet, set the
      // reservation.order_id to this order. Best-effort — a missed link does
      // not break ordering, only nightly reporting.
      //
      // Tables are stored with both an `id` ("T5") and a `number` (5). The
      // order's table_id column carries whichever the caller sent, normalised
      // (so "5", "05", "T5" all become "5"); the reservation's table_id
      // column carries the row's `id` ("T5") because resolveTableId in the
      // reservations handler returns the explicit `id`. Look up the row to
      // get both forms and try each — order id, table number as a string, and
      // the raw value the caller sent.
      if (tableId) {
        try {
          const tableRow = await resolveTableRow(env, tableId);
          const tableIdCandidates = new Set();
          tableIdCandidates.add(String(tableId));
          if (tableRow) {
            if (tableRow.id) tableIdCandidates.add(String(tableRow.id));
            if (tableRow.number !== undefined && tableRow.number !== null) {
              tableIdCandidates.add(String(tableRow.number));
            }
          }
          // Build IN (?, ?, ?) with the same number of placeholders as candidates.
          const candidates = Array.from(tableIdCandidates);
          const placeholders = candidates.map(() => '?').join(', ');
          await d1Run(
            env,
            `UPDATE reservations
                SET order_id = ?, updated_at = ?
              WHERE id = (
                SELECT id FROM reservations
                 WHERE table_id IN (${placeholders})
                   AND status = 'seated'
                   AND order_id IS NULL
                   AND released_at IS NULL
                   AND no_show_at IS NULL
                 ORDER BY updated_at DESC LIMIT 1
              )`,
            [id, nowIso, ...candidates]
          );
        } catch (e) {
          // A reservation-link failure must never cost the guest their order.
          console.error('[ORDERS] reservation link failed:', e);
        }
      }

      const warnings = [tracking.warning, ...followUps].filter(Boolean);
      if (guestRepriced) {
        warnings.unshift('Prices were set from the menu, so the total may differ from what you saw.');
      }
      return json({
        ok: true,
        id,
        items: tracking.inserted,
        payments: payments.inserted,
        deliveryId: delivery.id || undefined,
        repriced: guestRepriced || undefined,
        warning: warnings.length ? warnings.join(" ") : undefined,
      });
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 500);
    }
  }

  // ── Per-item timing ──────────────────────────────────────────────────────

  // GET /api/orders/timing?from=&to= - average time to table by category.
  if (m === "GET" && sub === "/timing") {
    const from = url && url.searchParams ? url.searchParams.get("from") : null;
    const to = url && url.searchParams ? url.searchParams.get("to") : null;
    const clauses = ["served_at IS NOT NULL"];
    const params = [];
    if (from) { clauses.push("served_at >= ?"); params.push(from); }
    if (to) { clauses.push("served_at <= ?"); params.push(to); }
    const { results } = await d1Query(
      env,
      `SELECT category, created_at, served_at FROM order_items WHERE ${clauses.join(" AND ")}`,
      params
    );
    const rows = results || [];
    return json({ ok: true, from, to, sampled: rows.length, categories: averageByCategory(rows) });
  }

  // GET /api/orders/items/active - every line on the board in one request.
  // The kitchen screen refreshes on a timer and on every SSE event; fetching
  // lines per order would fan one refresh out into a request per ticket.
  // Declared before the /:id/items route so "items" is not read as an order id.
  if (m === "GET" && sub === "/items/active") {
    // `o.created` comes back too, so a ticket nobody ever closed can be left
    // off the board. Six orders were sitting here as `new` from as far back as
    // 31 July; a chef scrolling past three weeks of dead tickets stops reading
    // the board at all. The orders themselves are untouched and still show in
    // Orders and, where money is owed, in Open Checks.
    const { results } = await d1Query(
      env,
      `SELECT oi.*, o.created AS order_created FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
        WHERE o.status NOT IN ('completed', 'cancelled', 'fulfilled')
          -- A guest's own order waits for a waiter.
          --
          -- The QR code on a table is a photograph anyone can keep, so an
          -- order arriving from one is a request, not an instruction. It
          -- reaches the pass once somebody on the floor has looked at the
          -- table and accepted it, which moves the order to 'confirmed'.
          --
          -- Staff-entered orders have no source and are unaffected: they go
          -- straight through exactly as before. If the cafe later takes
          -- payment at the time of ordering, this line is what to remove —
          -- the card becomes the check on abuse instead.
          AND (COALESCE(o.source, '') <> 'qr' OR o.status <> 'new')
        ORDER BY oi.order_id, oi.line_no`
    );
    const staleHours = (await loadStaleHours(env)).kitchen;
    const nowMs = Date.now();
    const live = (results || []).filter(
      (i) => !ticketStale({ created: i.order_created }, nowMs, staleHours)
    );
    return json(live.map((i) => Object.assign({}, i, { durations: itemDurations(i) })));
  }

  // GET /api/orders/:id/items
  if (m === "GET" && /^\/[^/]+\/items$/.test(sub)) {
    const orderId = sub.split("/")[1];
    const { results } = await d1Query(
      env,
      "SELECT * FROM order_items WHERE order_id = ? ORDER BY line_no",
      [orderId]
    );
    return json((results || []).map((i) => Object.assign({}, i, { durations: itemDurations(i) })));
  }

  // PATCH /api/orders/:id/items — append a round to an open order.
  //
  // The open-tab flow: a waiter fires a first round to the kitchen with POST,
  // which creates the order, and the table now has a tab. The next round on the
  // same table must extend that order rather than create a sibling — otherwise
  // the kitchen board shows two tickets for one sitting and the bill splits
  // into two orders at the till. This appends lines with the next line numbers
  // (via insertOrderItems' lineOffset) so the ticket keeps its sequence, and
  // recomputes the running bill from every line on the order.
  if (m === "PATCH" && /^\/[^/]+\/items$/.test(sub)) {
    const orderId = sub.split("/")[1];
    const data = await readBody(request);
    if (!data) return json({ ok: false, error: "Invalid JSON body" }, 400);

    const { results: orderRows } = await d1Query(env, "SELECT * FROM orders WHERE id = ?", [orderId]);
    const order = orderRows && orderRows[0];
    if (!order) return json({ ok: false, error: "Order not found" }, 404);
    if (order.voided_at) {
      return json({ ok: false, error: "Order has been voided and cannot take new items" }, 409);
    }
    // Food served is not the check closed. 'fulfilled' (the whole-ticket
    // Served button) and 'served' (the per-line roll-up) only say the last
    // round reached the table — dessert and after-dinner coffee are added to
    // a served ticket all night long. Blocking them here made the POS silently
    // open a second ticket for the same table: two checks to settle at the
    // till, and the first one leaks. Only cancellation, completion or actual
    // payment close a check to new lines.
    const orderStatus = String(order.status || "").toLowerCase();
    if (["completed", "cancelled"].includes(orderStatus)) {
      return json({ ok: false, error: "Order is closed and cannot take new items" }, 409);
    }
    if (String(order.payment_status || "").toLowerCase() === "paid") {
      return json({ ok: false, error: "Order has been paid and cannot take new items" }, 409);
    }

    // Continue the ticket's numbering where the last round left off. Note the
    // explicit null check: line_no 0 is a valid row (the very first line of a
    // ticket), and `raw || -1` would misread it as "no lines yet".
    const { results: lineRows } = await d1Query(
      env,
      "SELECT MAX(line_no) AS maxLineNo FROM order_items WHERE order_id = ?",
      [orderId]
    );
    const rawMax = lineRows && lineRows[0] ? lineRows[0].maxLineNo : null;
    const maxLineNo = rawMax === null || rawMax === undefined ? -1 : Number(rawMax);
    const lineOffset = maxLineNo + 1;

    const nowIso = new Date().toISOString();
    const tracking = await insertOrderItems(
      env,
      orderId,
      data.orderItems || data.order_items || data.items,
      nowIso,
      lineOffset
    );
    if (!tracking.inserted) {
      return json({ ok: false, error: "No orderable items in request", warning: tracking.warning }, 400);
    }

    // Recompute the running bill from the lines now on the order, so the total
    // always matches the sum of what the kitchen has been fired. The flat
    // summary the receipt reads is rebuilt by appending this round's lines.
    // The same re-read carries each line's status, because appending a round
    // has to put a served ticket back into the kitchen flow: a status of
    // 'fulfilled' or 'served' with unfired lines on it is invisible to the
    // board (items/active and the SSE feed both exclude terminal states), and
    // the chef would never see the round fire.
    const { results: allLines } = await d1Query(
      env,
      "SELECT unit_price, qty, status FROM order_items WHERE order_id = ? AND status <> 'cancelled'",
      [orderId]
    );
    const subtotal = round2(
      (allLines || []).reduce((s, l) => s + (Number(l.unit_price) || 0) * (Number(l.qty) || 0), 0)
    );
    const tip = Number(order.tip) || 0;
    const discount = Number(order.discount) || 0;
    const serviceCharge = Number(order.service_charge) || 0;
    const tax = Number(order.tax) || 0;
    const deliveryFee = Number(order.delivery_fee) || 0;
    const total = round2(subtotal - discount + tip + serviceCharge + tax + deliveryFee);

    const flat = typeof data.items === "string" ? data.items.trim() : "";
    const itemsSummary = order.items
      ? String(order.items).trim() + (flat ? ", " + flat : "")
      : flat;

    // Roll the order's own status forward from its lines — the same rule the
    // per-line route uses — so a re-opened ticket re-enters the kitchen flow at
    // the state its lines actually describe. Two served lines plus two new
    // ones read as 'preparing': the board shows the ticket with the new lines
    // tappable and the old ones struck through.
    const rolled = deriveOrderStatus((allLines || []).map((l) => l.status));

    if (rolled) {
      await d1Run(
        env,
        "UPDATE orders SET items = ?, subtotal = ?, total = ?, status = ?, updated_at = ? WHERE id = ?",
        [itemsSummary, subtotal, total, rolled, nowIso, orderId]
      );
    } else {
      await d1Run(
        env,
        "UPDATE orders SET items = ?, subtotal = ?, total = ?, updated_at = ? WHERE id = ?",
        [itemsSummary, subtotal, total, nowIso, orderId]
      );
    }

    await writeAudit(env, auth, {
      action: "update",
      entity: "orders",
      entityId: orderId,
      before: { total: order.total, items: order.items },
      after: { total, items: itemsSummary, addedLines: tracking.inserted },
    });

    return json({
      ok: true,
      orderId,
      items: tracking.inserted,
      subtotal,
      total,
      orderStatus: rolled || orderStatus,
      warning: tracking.warning || undefined,
    });
  }

  // POST /api/orders/:id/split — split an open check evenly across seats
  //
  // The parent check is retired and N unpaid child orders carry its money,
  // one payment each. Two invariants matter:
  //   1. The parts sum to the whole: the last split absorbs the rounding
  //      remainder, so a ETB 100 three-way split is 33.34 + 33.33 + 33.33.
  //   2. Revenue is counted once: the parent is cancelled with a reason
  //      (excluded from reports, open checks and the boards) and only the
  //      splits remain as real money. The items stay attached to the parent
  //      for history — an even seat split cannot divide dishes.
  // The previous version INSERTed columns (table_number, created_at) that do
  // not exist on `orders`, so every split attempt returned 500.
  if (m === "POST" && /^\/[^/]+\/split$/.test(sub)) {
    const orderId = sub.split("/")[1];
    const data = await readBody(request);
    if (!data) return json({ ok: false, error: "Invalid JSON body" }, 400);

    const { results } = await d1Query(env, "SELECT * FROM orders WHERE id = ?", [orderId]);
    const order = results && results[0];
    if (!order) return json({ ok: false, error: "Order not found" }, 404);
    if (order.voided_at) return json({ ok: false, error: "This check has been voided and cannot be split." }, 409);
    if (String(order.payment_status || "").toLowerCase() === "paid") {
      return json({ ok: false, error: "This check is already settled." }, 409);
    }
    const outstanding = parseFloat(order.total || 0);
    if (!(outstanding > 0)) return json({ ok: false, error: "Nothing owed on this check to split." }, 409);

    const nowIso = new Date().toISOString();
    const seatCount = Math.max(2, Math.min(10, parseInt(data.seatCount || 2, 10) || 2));
    const evenShare = round2(outstanding / seatCount);

    const createdSplits = [];
    for (let i = 0; i < seatCount; i++) {
      const splitId = `ORD-SPLIT-${Date.now().toString(36)}-${i+1}`;
      const share = i === seatCount - 1 ? round2(outstanding - evenShare * (seatCount - 1)) : evenShare;
      await d1Run(
        env,
        `INSERT INTO orders (id, type, table_id, customer, status, payment_status, items, subtotal, total, created, notes)
         VALUES (?, ?, ?, ?, 'new', 'unpaid', ?, ?, ?, ?, ?)`,
        [
          splitId,
          order.type || "dine-in",
          order.table_id || null,
          order.customer || null,
          `Split ${i+1}/${seatCount} of Order #${orderId.slice(-4)}`,
          share,
          share,
          nowIso,
          `Split bill ${i+1} of ${seatCount} from #${orderId.slice(-4)}`,
        ]
      );
      createdSplits.push({ id: splitId, total: share });
    }

    await d1Run(
      env,
      `UPDATE orders SET status = 'cancelled', payment_status = 'split',
              void_reason = ?, voided_at = ?, void_category = 'other', updated_at = ?
        WHERE id = ?`,
      [`Split into ${seatCount} checks`, nowIso, nowIso, orderId]
    );
    await writeAudit(env, auth, {
      action: "split",
      entity: "orders",
      entityId: orderId,
      before: { status: order.status, total: order.total },
      after: { status: "cancelled", splitsCount: seatCount, createdSplits: createdSplits.map(s => s.id) },
    });

    return json({ ok: true, parentOrderId: orderId, splits: createdSplits });
  }

  // POST /api/orders/merge — merge two open checks/orders into one
  if (m === "POST" && sub === "/merge") {
    const data = await readBody(request);
    if (!data || !data.sourceOrderId || !data.targetOrderId) {
      return json({ ok: false, error: "sourceOrderId and targetOrderId required" }, 400);
    }

    const { results: srcRows } = await d1Query(env, "SELECT * FROM orders WHERE id = ?", [data.sourceOrderId]);
    const { results: tgtRows } = await d1Query(env, "SELECT * FROM orders WHERE id = ?", [data.targetOrderId]);
    const src = srcRows && srcRows[0];
    const tgt = tgtRows && tgtRows[0];

    if (!src || !tgt) return json({ ok: false, error: "One or both orders not found" }, 404);

    const nowIso = new Date().toISOString();
    // Move all items from source order to target order
    await d1Run(env, "UPDATE order_items SET order_id = ? WHERE order_id = ?", [tgt.id, src.id]);

    // Recalculate target order total
    const { results: allItems } = await d1Query(env, "SELECT unit_price, qty FROM order_items WHERE order_id = ? AND status <> 'cancelled'", [tgt.id]);
    const newSubtotal = round2((allItems || []).reduce((s, l) => s + (Number(l.unit_price) || 0) * (Number(l.qty) || 0), 0) || (parseFloat(tgt.total || 0) + parseFloat(src.total || 0)));
    const newTotal = newSubtotal;

    await d1Run(env, "UPDATE orders SET subtotal = ?, total = ?, updated_at = ? WHERE id = ?", [newSubtotal, newTotal, nowIso, tgt.id]);
    await d1Run(env, "UPDATE orders SET status = 'cancelled', void_reason = 'Merged into order " + tgt.id + "', updated_at = ? WHERE id = ?", [nowIso, src.id]);

    await writeAudit(env, auth, { action: "merge", entity: "orders", entityId: tgt.id, after: { mergedFrom: src.id, newTotal } });
    return json({ ok: true, targetOrderId: tgt.id, mergedFrom: src.id, newTotal });
  }

  // PATCH /api/orders/:id/move-item — move a line item from one order to another
  if (m === "PATCH" && /^\/[^/]+\/move-item$/.test(sub)) {
    const orderId = sub.split("/")[1];
    const data = await readBody(request);
    if (!data || !data.itemId || !data.targetOrderId) {
      return json({ ok: false, error: "itemId and targetOrderId required" }, 400);
    }
    const nowIso = new Date().toISOString();
    await d1Run(env, "UPDATE order_items SET order_id = ? WHERE id = ? AND order_id = ?", [data.targetOrderId, data.itemId, orderId]);

    // Recalculate totals for both orders
    for (const oid of [orderId, data.targetOrderId]) {
      const { results: lines } = await d1Query(env, "SELECT unit_price, qty FROM order_items WHERE order_id = ? AND status <> 'cancelled'", [oid]);
      const sub = round2((lines || []).reduce((s, l) => s + (Number(l.unit_price) || 0) * (Number(l.qty) || 0), 0));
      await d1Run(env, "UPDATE orders SET subtotal = ?, total = ?, updated_at = ? WHERE id = ?", [sub, sub, nowIso, oid]);
    }

    return json({ ok: true, itemId: data.itemId, fromOrder: orderId, toOrder: data.targetOrderId });
  }

  // GET /api/orders/:id — one order with its lines attached.
  //
  // This is the single-order endpoint the open-tab flow needs: a waiter who has
  // an unpaid order on a table has to be able to fetch it (with items) to show
  // the running bill and to append a new round to it. Without it, the POS could
  // list orders but never look one up, so the only way back to an open tab was
  // re-typing the whole cart. Declared after the /:id/items routes so "items" is
  // not swallowed as an order id.
  /**
   * GET /api/orders/pending — guests' orders waiting for somebody to accept.
   *
   * Its own route rather than a filter on the orders list, because this is a
   * question the floor asks constantly and the answer must be small and fast.
   */
  if (m === "GET" && sub === "/pending") {
    if (!auth) return json({ ok: false, error: "Authentication required" }, 401);
    const { results } = await d1Query(
      env,
      `SELECT * FROM orders WHERE COALESCE(source, '') = 'qr' AND status = 'new' ORDER BY created`
    );
    return json((results || []).map(mapOrderRow));
  }

  if (m === "GET" && /^\/[^/]+$/.test(sub)) {
    const orderId = sub.slice(1);
    const { results } = await d1Query(env, "SELECT * FROM orders WHERE id = ?", [orderId]);
    const order = results && results[0];
    if (!order) return json({ ok: false, error: "Order not found" }, 404);

    const { results: lines } = await d1Query(
      env,
      "SELECT * FROM order_items WHERE order_id = ? ORDER BY line_no",
      [orderId]
    );
    const items = (lines || []).map((i) => Object.assign({}, i, { durations: itemDurations(i) }));

    return json({ ...mapOrderRow(order), items });
  }

  // POST /api/orders/:id/transfer  { tableNumber }
  /**
   * POST /api/orders/:id/accept — a waiter takes responsibility for a guest's
   * order, and only then does the kitchen see it.
   *
   * This is the human check that a printed code cannot provide. The floor
   * screen lists what is waiting, somebody glances at the table, and taps once.
   *
   * Requires a session: the point of the step is that a person did it. It is
   * audited for the same reason — "who let this into the kitchen" is a
   * question worth being able to answer.
   */
  if (m === "POST" && /^\/[^/]+\/accept$/.test(sub)) {
    const orderId = sub.split("/")[1];
    if (!auth) return json({ ok: false, error: "Authentication required" }, 401);

    const { results } = await d1Query(env, "SELECT * FROM orders WHERE id = ?", [orderId]);
    const order = results && results[0];
    if (!order) return json({ ok: false, error: "Order not found" }, 404);

    // Accepting anything else is meaningless rather than harmful, but saying so
    // is better than pretending something happened.
    if (String(order.source || "") !== "qr") {
      return json({ ok: false, error: "That order did not come from a table code." }, 400);
    }
    if (String(order.status) !== "new") {
      return json({ ok: true, alreadyAccepted: true, id: orderId, status: order.status });
    }

    await d1Run(env, "UPDATE orders SET status = 'confirmed', updated_at = ? WHERE id = ? AND status = 'new'", [
      new Date().toISOString(),
      orderId,
    ]);
    await writeAudit(env, auth, {
      action: "update",
      entity: "orders",
      entityId: orderId,
      before: { status: "new" },
      after: { status: "confirmed" },
      reason: `Table order accepted by ${actorName(auth)}`,
    });

    return json({ ok: true, id: orderId, status: "confirmed" });
  }

  if (m === "POST" && /^\/[^/]+\/transfer$/.test(sub)) {
    return transferCheck(sub.split("/")[1], request, env, auth);
  }

  // PUT /api/orders/:orderId/items/:itemId  { status }
  // Marking one line moves that line only, then the order's own status is
  // recomputed from all of its lines so the kitchen board stays coherent.
  if (m === "PUT" && /^\/[^/]+\/items\/[^/]+$/.test(sub)) {
    const [, orderId, , itemId] = sub.split("/");
    const data = await readBody(request);
    if (!data) return json({ ok: false, error: "Invalid JSON body" }, 400);

    const status = String(data.status || "").toLowerCase();
    if (!isValidItemStatus(status)) {
      return json({ ok: false, error: `Unknown item status "${data.status}"` }, 400);
    }

    const nowIso = new Date().toISOString();
    const stamp = stampColumnFor(status);
    // The timestamp is only written the first time a line enters a state, so
    // re-tapping "ready" cannot quietly reset the clock and shorten the
    // recorded duration.
    const sql = stamp
      ? `UPDATE order_items SET status = ?, ${stamp} = COALESCE(${stamp}, ?) WHERE id = ? AND order_id = ?`
      : `UPDATE order_items SET status = ? WHERE id = ? AND order_id = ?`;
    const params = stamp ? [status, nowIso, itemId, orderId] : [status, itemId, orderId];

    const { meta } = await d1Run(env, sql, params);
    if (!meta.changes) return json({ ok: false, error: "Order item not found" }, 404);

    const { results } = await d1Query(
      env,
      "SELECT status FROM order_items WHERE order_id = ?",
      [orderId]
    );
    const rolled = deriveOrderStatus((results || []).map((r) => r.status));
    if (rolled) {
      const orderStamp = stampColumnFor(rolled);
      const orderSql = orderStamp
        ? `UPDATE orders SET status = ?, updated_at = ?, ${orderStamp} = COALESCE(${orderStamp}, ?) WHERE id = ?`
        : `UPDATE orders SET status = ?, updated_at = ? WHERE id = ?`;
      await d1Run(
        env,
        orderSql,
        orderStamp ? [rolled, nowIso, nowIso, orderId] : [rolled, nowIso, orderId]
      );
    }

    return json({ ok: true, status, orderStatus: rolled });
  }

  if (m === "PUT" && sub.startsWith("/")) {
    const id = sub.slice(1);
    const data = await readBody(request);
    if (!data) return json({ ok: false, error: "Invalid JSON body" }, 400);
    const fields = [];
    const values = [];
    const nowIso = new Date().toISOString();
    let consumptionWarning = null;
    // Warnings from posting a settlement (payment rows, tip row). They never
    // fail the PUT — the bill must be payable even if a payment record drops —
    // and ride the response's warning field alongside the consumption warning.
    const followSettlementWarnings = [];

    // Read first, so the audit entry can say what the value was. §37 asks for
    // the previous value on a change, and a discount or a price amendment is
    // exactly the case where "it used to be" is the whole question.
    const { results: prior } = await d1Query(env, "SELECT * FROM orders WHERE id = ?", [id]);
    const before = (prior && prior[0]) || null;
    if (before && before.voided_at) {
      return json({ ok: false, error: "Order has been voided and cannot be changed" }, 409);
    }
    if (data.status !== void 0) {
      fields.push("status = ?");
      values.push(data.status);
      // Stamp the moment this order reached the state, first time only, so a
      // second tap on "Mark Ready" cannot rewind the recorded duration.
      // KitchenView has always rendered "ready for N min" from a column that
      // did not exist; updated_at below is what makes that figure real.
      const stamp = stampColumnFor(String(data.status).toLowerCase());
      if (stamp) {
        fields.push(`${stamp} = COALESCE(${stamp}, ?)`);
        values.push(nowIso);
      }
    }
    if (data.items !== void 0) {
      fields.push("items = ?");
      values.push(typeof data.items === "string" ? data.items : JSON.stringify(data.items));
    }
    if (data.total !== void 0) {
      fields.push("total = ?");
      values.push(data.total);
    }
    if (data.payment !== void 0) {
      fields.push("payment = ?");
      values.push(data.payment);
    }
    if (data.type !== void 0) {
      fields.push("type = ?");
      values.push(data.type);
    }
    if (data.table_id !== void 0 || data.table_number !== void 0) {
      fields.push("table_id = ?");
      values.push(normaliseTableId(data.tableNum || data.table_id || data.table_number));
    }
    if (data.customer !== void 0 || data.name !== void 0) {
      fields.push("customer = ?");
      values.push(data.customer || data.name || null);
    }
    if (data.email !== void 0) {
      fields.push("email = ?");
      values.push(data.email);
    }
    if (data.notes !== void 0) {
      fields.push("notes = ?");
      values.push(typeof data.notes === "string" ? data.notes.trim() : "");
    }
    // Amending a bill after it has been opened: a discount applied at the till,
    // a tip added when the guest pays, a delivery fee agreed on the phone.
    // Filtered against the live schema so this works either side of migration
    // 005, for the same reason the INSERT is.
    const editableMoney = {
      subtotal: data.subtotal,
      discount: data.discount,
      discount_type: data.discountType ?? data.discount_type,
      discount_reason: data.discountReason ?? data.discount_reason,
      tip: data.tip,
      tip_type: data.tipType ?? data.tip_type,
      service_charge: data.serviceCharge ?? data.service_charge,
      tax: data.tax,
      delivery_fee: data.deliveryFee ?? data.delivery_fee,
      customer_phone: data.customerPhone ?? data.customer_phone,
      pickup_status: data.pickupStatus ?? data.pickup_status,
    };
    const liveCols = await orderColumns(env);
    for (const [col, val] of Object.entries(editableMoney)) {
      if (val === void 0 || !liveCols.includes(col)) continue;
      fields.push(`${col} = ?`);
      values.push(typeof val === "string" ? val : round2(val));
    }
    // A takeaway handed over is picked up; stamping it here means the counter
    // does not need a second call to close the order out.
    if (data.pickupStatus === "collected" && liveCols.includes("picked_up_at")) {
      fields.push("picked_up_at = COALESCE(picked_up_at, ?)");
      values.push(nowIso);
    }
    if (fields.length === 0) return json({ ok: false, error: "No fields to update" }, 400);
    fields.push("updated_at = ?");
    values.push(nowIso);
    values.push(id);
    const { meta } = await d1Run(env, `UPDATE orders SET ${fields.join(", ")} WHERE id = ?`, values);
    if (!meta.changes) return json({ ok: false, error: "Order not found" }, 404);

    // Advancing the whole order has to advance its lines too. Without this the
    // order would read "ready" while every line still reads "new", and the next
    // per-item tap would recompute the order straight back to "preparing".
    // Only lines behind the new state move, so a line already served is never
    // dragged backwards.
    if (data.status !== void 0) {
      const target = ORDER_TO_ITEM_STATUS[String(data.status).toLowerCase()];
      if (target) {
        const behind = ITEM_FLOW.slice(0, flowIndex(target)).map((s) => `'${s}'`).join(", ");
        const stamp = stampColumnFor(target);
        const setClause = stamp
          ? `status = ?, ${stamp} = COALESCE(${stamp}, ?)`
          : `status = ?`;
        const args = stamp ? [target, nowIso, id] : [target, id];
        await d1Run(
          env,
          `UPDATE order_items SET ${setClause} WHERE order_id = ? AND status IN (${behind})`,
          args
        );
      }
    }

    // The chef marking food ready is what should put a delivery in front of a
    // driver. Before this, somebody had to remember to move the job by hand on
    // a second screen, which is the kind of step that gets skipped at 8pm.
    if (data.status !== void 0) {
      await syncDeliveryToOrderStatus(env, id, data.status);
    }

    // ── Sale → recipe → ingredient consumption ──────────────────────────────
    // Posted when the kitchen marks the food ready, because that is the moment
    // the ingredients were physically used. Waiting for payment would leave the
    // shelf wrong for as long as a table sits, and posting at order time would
    // deduct for food that is later cancelled.
    //
    // Idempotent via orders.consumed_at, so a second tap on "Ready" cannot
    // deduct twice — the double-deduction failure in §56.
    if (data.status !== void 0 && CONSUME_ON_STATUS.has(String(data.status).toLowerCase())) {
      const consumed = await consumeForOrder(env, auth, id);
      if (!consumed.ok) {
        // Never fails the status change. The kitchen must be able to say food
        // is ready whatever the stock records think, and a warning that
        // reaches the manager is the right escalation — not a blocked pass.
        consumptionWarning = consumed.error;
      } else if (consumed.warnings && consumed.warnings.length) {
        consumptionWarning = consumed.warnings.join('; ');
      }
    }

    // The bill changed, so what is owed on it changed. Derived rather than
    // assumed, so an order cannot end up marked paid without payments behind it.
    if (data.total !== void 0 || data.tip !== void 0 || data.discount !== void 0) {
      try { await refreshPaymentStatus(env, id); } catch { /* status is recomputed on next read */ }
    }

    // ── Settlement of an open tab ─────────────────────────────────────────
    // Checkout no longer creates a second order to take the money: it PUTs the
    // existing order with its payment breakdown and tip. The payment and tip
    // rows are posted here — the same path POST /orders uses — so a split bill
    // and a waiter's tip land on the order that actually ran. Both helpers are
    // idempotent (recordSubmittedPayments refuses to double-post, and
    // recordSubmittedTip skips an order that already has a tip row), so a
    // retried PUT cannot take the same cash twice.
    if (Array.isArray(data.paymentBreakdown) && data.paymentBreakdown.length) {
      const settlement = await recordSubmittedPayments(env, auth, id, data);
      if (settlement.warning) followSettlementWarnings.push(settlement.warning);
    }
    const settleTip = round2(data.tip);
    if (settleTip > 0) {
      const tipResult = await recordSubmittedTip(env, auth, id, data, settleTip, data.type || before?.type || null);
      if (tipResult.warning) followSettlementWarnings.push(tipResult.warning);
    }

    await writeAudit(env, auth, {
      action: "update",
      entity: "orders",
      entityId: id,
      before,
      after: Object.fromEntries(
        fields
          .map((f, i) => [f.split(" ")[0], values[i]])
          .filter(([c]) => c !== "updated_at")
      ),
    });

    const warnings = [consumptionWarning, ...followSettlementWarnings].filter(Boolean);
    return json({ ok: true, updated_at: nowIso, warning: warnings.length ? warnings.join(" ") : undefined });
  }
  // DELETE voids the order; it does not remove it.
  //
  // The row is a sale, and it owns its lines, its payments and (once the recipe
  // engine posts) its stock consumption. Deleting it destroyed all of that in
  // one statement with nothing recorded — a cancelled order is still a fact
  // about the day's trading and the accountant has to be able to see it. §37 of
  // the spec requires void/reverse over deletion for exactly this reason.
  if (m === "DELETE" && sub.startsWith("/")) {
    const id = sub.slice(1);
    let body = null;
    try { body = await readBody(request); } catch { /* DELETE commonly has no body */ }
    const reason = body && body.reason ? String(body.reason).trim() : "";

    // Finding 3 (B+ sim): a `void_category` tag distinguishes operator-error
    // voids (training, mis-fired API calls, wrong method) from real customer-
    // or kitchen-driven voids. The audit log treated every void the same, so
    // a 33% operator-error void rate looked identical to a 33% walk-away rate.
    // Categories: training | customer | kitchen | fraud | other. Optional —
    // defaults to 'other' so existing callers keep working.
    const VOID_CATEGORIES = new Set(['training', 'customer', 'kitchen', 'fraud', 'other']);
    const voidCategory =
      body && body.void_category
        ? (VOID_CATEGORIES.has(String(body.void_category).toLowerCase())
            ? String(body.void_category).toLowerCase()
            : 'other')
        : 'other';

    const { results } = await d1Query(env, "SELECT * FROM orders WHERE id = ?", [id]);
    const order = results && results[0];
    if (!order) return json({ ok: false, error: "Order not found" }, 404);
    if (order.voided_at) return json({ ok: false, error: "Order is already voided" }, 409);

    // Money already taken has to be dealt with deliberately. Voiding around it
    // would leave payments attached to an order that no longer counts, which is
    // how a till reconciles short with nothing to point at.
    const { results: pays } = await d1Query(
      env,
      "SELECT id, amount, method, status FROM payments WHERE order_id = ? AND status <> 'rejected'",
      [id]
    );
    const taken = (pays || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
    if (Math.round(taken * 100) / 100 > 0 && !isManager((auth && (auth.sessionRole || auth.role)) || "")) {
      return json(
        { ok: false, error: "This order has been paid. A manager must refund it before voiding." },
        409
      );
    }

    const nowIso = new Date().toISOString();
    // The void_category column arrives in migration 020. If the migration has
    // not yet been applied (CI deploys on push, migrations are run by hand),
    // the UPDATE would fail at the column reference. Two UPDATEs is uglier
    // than one, but a missing column must never block a void — the cashier
    // needs the order off the board, and the audit log will still carry the
    // category in its `after` payload.
    const orderCols = await orderColumns(env);
    const hasVoidCategory = orderCols.includes('void_category');
    await d1Run(
      env,
      hasVoidCategory
        ? `UPDATE orders
              SET status = 'cancelled',
                  voided_at = ?, voided_by = ?, void_reason = ?, void_category = ?,
                  updated_at = ?
            WHERE id = ?`
        : `UPDATE orders
              SET status = 'cancelled',
                  voided_at = ?, voided_by = ?, void_reason = ?,
                  updated_at = ?
            WHERE id = ?`,
      hasVoidCategory
        ? [nowIso, auth ? actorName(auth) : null, reason || null, voidCategory, nowIso, id]
        : [nowIso, auth ? actorName(auth) : null, reason || null, nowIso, id]
    );
    // The lines go with it, so the kitchen board clears and the timing report
    // does not average in food that was never served.
    await d1Run(
      env,
      "UPDATE order_items SET status = 'cancelled' WHERE order_id = ? AND status <> 'served'",
      [id]
    );
    await d1Run(env, "UPDATE delivery SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE orderId = ?", [
      nowIso, nowIso, id,
    ]);

    // Finding 2 (B+ sim): voiding a paid cash order left the drawer's
    // `cash_sales` carrying "phantom" cash that was actually handed back to
    // the guest as a refund. The original cash sale row stayed verified, the
    // drawer stayed inflated, and the manager saw variance at Z-count with no
    // link back to the void. The fix: when a manager voids a paid order, every
    // verified cash payment on it is auto-refunded — a negative payment row
    // is inserted (mirroring the existing refundPayment path), the original is
    // marked refunded, and `addToOpenDrawerCash` brings the drawer tally down
    // by the same figure. Non-cash payments (telebirr/bank/card) are left
    // alone here — their refund flow is settled outside the till.
    let autoRefunded = 0;
    let autoRefundIds = [];
    for (const p of (pays || [])) {
      const amount = round2(Number(p.amount) || 0);
      if (amount <= 0) continue;
      if (String(p.method || '').toLowerCase() !== 'cash') continue;
      if (String(p.status || '').toLowerCase() === 'refunded') continue;

      const refundId = 'PM' + crypto.randomUUID().slice(0, 10);
      try {
        await d1Run(
          env,
          `INSERT INTO payments
             (id, order_id, method, amount, reference, status, collected_by, collected_by_name,
              verified_by, verified_by_name, verified_at, notes, created_at)
           VALUES (?, ?, ?, ?, ?, 'verified', ?, ?, ?, ?, ?, ?, ?)`,
          [
            refundId,
            id,
            'cash',
            -amount,
            p.reference || null,
            (auth && auth.staff_id) || null,
            auth ? actorName(auth) : null,
            (auth && auth.staff_id) || null,
            auth ? actorName(auth) : null,
            nowIso,
            `Auto-refund for voided order ${id}: ${reason || 'no reason given'}`,
            nowIso,
          ]
        );
        await d1Run(env, "UPDATE payments SET status = 'refunded' WHERE id = ?", [p.id]);
        await addToOpenDrawerCash(env, -amount);
        autoRefunded = round2(autoRefunded + amount);
        autoRefundIds.push(refundId);
      } catch (e) {
        // A refund failure must not undo the void. The manager will see the
        // unrefunded payment row in the audit log and can settle it manually.
      }
    }

    // The auto-refund hands back the whole cash payment, and on a paid order
    // that amount includes the tip — so the tip is no longer staff money. The
    // tips row used to stay 'recorded', keeping "Tips Earned" counting money
    // that had gone back to the guest. Flip it to refunded; reporting sums
    // only non-refunded tips, and the row itself keeps the history.
    if (autoRefunded > 0) {
      await d1Run(
        env,
        "UPDATE tips SET status = 'refunded' WHERE order_id = ? AND status <> 'refunded'",
        [id]
      ).catch(() => {});
    }

    // Put back what the order took. A reversal rather than a deletion: the
    // original sale movements stay and matching positive rows are added, so the
    // ledger shows the stock going out and coming back, which is what happened.
    // Food already cooked is not recovered, so this is the manager's call —
    // `keepConsumption` leaves the deduction standing and the waste visible.
    let restocked = 0;
    if (!body || !body.keepConsumption) {
      const reversal = await reverseOrderConsumption(env, auth, id, reason || 'Order voided');
      restocked = reversal.posted || 0;
    }

    await writeAudit(env, auth, {
      action: "void",
      entity: "orders",
      entityId: id,
      before: { status: order.status, total: order.total },
      after: { status: "cancelled", voided_at: nowIso, void_category: voidCategory, auto_refunded: autoRefunded },
      reason: reason || null,
    });

    return json({ ok: true, voided: true, id, restocked, void_category: voidCategory, auto_refunded: autoRefunded, refund_ids: autoRefundIds });
  }
  return null;
}
export { mapOrderRow, handleOrders, loadStaleHours, resetOrderColumns, resetOrderItemColumns, round2, openChecksForStaff };
