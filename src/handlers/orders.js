import { d1Query, d1Run, json, readBody } from '../lib/db.js';
import { writeAudit } from '../lib/audit.js';
import { actorName, isManager } from '../auth.js';
import { refreshPaymentStatus } from './payments.js';
import { syncDeliveryToOrderStatus } from './delivery.js';
import { consumeForOrder, reverseOrderConsumption } from '../lib/ledger.js';

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
 * Write one tracking row per order line.
 *
 * Deliberately never throws: an order the kitchen cannot time is still an order
 * the guest is waiting for, and taking ordering offline to protect a metric is
 * the wrong trade. Failures come back as a warning on the response instead of
 * disappearing.
 */
async function insertOrderItems(env, orderId, items, createdIso) {
  const lines = normaliseLines(items);
  if (!lines.length) return { inserted: 0, warning: null };

  try {
    const lookup = await categoryLookup(env);
    const statements = lines.map((line) =>
      env.DB.prepare(
        `INSERT INTO order_items
           (id, order_id, line_no, menu_item_id, name, category, qty, unit_price,
            modifiers, notes, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`
      ).bind(
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
        createdIso
      )
    );
    await env.DB.batch(statements);
    return { inserted: lines.length, warning: null };
  } catch (e) {
    return { inserted: 0, warning: `Order saved, but per-item timing was not recorded: ${String(e.message || e)}` };
  }
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
    const nowIso = new Date().toISOString();
    const statements = breakdown
      .filter((p) => p && Number(p.amount))
      .map((p) => {
        const method = String(p.method || "cash").toLowerCase();
        // A transfer is only settled once somebody has seen the evidence.
        const status = ["telebirr", "cbe", "bank"].includes(method) ? "recorded" : "verified";
        return env.DB.prepare(
          `INSERT INTO payments
             (id, order_id, method, amount, tendered, change_due, reference, evidence_key,
              status, collected_by, collected_by_name, verified_by, verified_by_name,
              verified_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
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
        );
      });

    if (!statements.length) return { inserted: 0, warning: null };
    await env.DB.batch(statements);
    await refreshPaymentStatus(env, orderId);
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

async function handleOrders(pathname, method, url, request, env, auth) {
  const m = method.toUpperCase();
  const sub = pathname.replace(/^\/api\/orders/, "");
  if (m === "GET" && sub === "") {
    const tableFilter = url && url.searchParams ? url.searchParams.get("table_number") : null;
    let rows;
    if (tableFilter) {
      const { results } = await d1Query(env, "SELECT * FROM orders WHERE table_id = ? ORDER BY created DESC", [String(tableFilter)]);
      rows = results || [];
    } else {
      const { results } = await d1Query(env, "SELECT * FROM orders ORDER BY created DESC");
      rows = results || [];
    }
    return json(rows.map(mapOrderRow));
  }
  if (m === "POST" && sub === "") {
    const data = await readBody(request);
    if (!data) return json({ ok: false, error: "Invalid JSON body" }, 400);
    try {
      const id = data.id || "O" + crypto.randomUUID().slice(0, 7);
      const items = typeof data.items === "string" ? data.items : JSON.stringify(data.items || []);
      const tableId = data.tableNum || data.table_number || data.table_id || null;
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
      const row = {
        id,
        items,
        total: round2(data.total),
        payment: data.payment || null,
        type: orderType,
        table_id: tableId,
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
      const payments = await recordSubmittedPayments(env, auth, id, data);
      if (payments.warning) followUps.push(payments.warning);

      const tipResult = await recordSubmittedTip(env, auth, id, data, tip, orderType);
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
        },
      });

      const warnings = [tracking.warning, ...followUps].filter(Boolean);
      return json({
        ok: true,
        id,
        items: tracking.inserted,
        payments: payments.inserted,
        deliveryId: delivery.id || undefined,
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
    const { results } = await d1Query(
      env,
      `SELECT oi.* FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
        WHERE o.status NOT IN ('completed', 'cancelled', 'fulfilled')
        ORDER BY oi.order_id, oi.line_no`
    );
    return json((results || []).map((i) => Object.assign({}, i, { durations: itemDurations(i) })));
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

  // GET /api/orders/:id — one order with its lines attached.
  //
  // This is the single-order endpoint the open-tab flow needs: a waiter who has
  // an unpaid order on a table has to be able to fetch it (with items) to show
  // the running bill and to append a new round to it. Without it, the POS could
  // list orders but never look one up, so the only way back to an open tab was
  // re-typing the whole cart. Declared after the /:id/items routes so "items" is
  // not swallowed as an order id.
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
      values.push(data.tableNum || data.table_id || data.table_number || null);
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

    return json({ ok: true, updated_at: nowIso, warning: consumptionWarning || undefined });
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

    const { results } = await d1Query(env, "SELECT * FROM orders WHERE id = ?", [id]);
    const order = results && results[0];
    if (!order) return json({ ok: false, error: "Order not found" }, 404);
    if (order.voided_at) return json({ ok: false, error: "Order is already voided" }, 409);

    // Money already taken has to be dealt with deliberately. Voiding around it
    // would leave payments attached to an order that no longer counts, which is
    // how a till reconciles short with nothing to point at.
    const { results: pays } = await d1Query(
      env,
      "SELECT id, amount FROM payments WHERE order_id = ? AND status <> 'rejected'",
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
    await d1Run(
      env,
      `UPDATE orders
          SET status = 'cancelled', voided_at = ?, voided_by = ?, void_reason = ?, updated_at = ?
        WHERE id = ?`,
      [nowIso, auth ? actorName(auth) : null, reason || null, nowIso, id]
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
      after: { status: "cancelled", voided_at: nowIso },
      reason: reason || null,
    });

    return json({ ok: true, voided: true, id, restocked });
  }
  return null;
}
export { mapOrderRow, handleOrders, resetOrderColumns, round2 };
