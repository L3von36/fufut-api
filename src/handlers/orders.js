import { d1Query, d1Run, json, readBody } from '../lib/db.js';
import {
  normaliseLines,
  stampColumnFor,
  isValidItemStatus,
  deriveOrderStatus,
  itemDurations,
  averageByCategory,
} from '../lib/timing.js';

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

async function handleOrders(pathname, method, url, request, env) {
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
      const base = [id, items, Number(data.total) || 0, data.payment || null, data.order_type || data.type || null, tableId, data.name || data.customer || null, data.status || "new", data.email || ""];
      // The POS checkout has an order-notes field intended for allergies and prep
      // instructions ("no dairy - allergy"). It was serialized into the payload but
      // the orders table had no column for it, so it was silently dropped before
      // reaching the kitchen.
      //
      // The write is attempted with `notes` and retried without it if the column is
      // not present yet. That keeps order creation working either side of the
      // `ALTER TABLE orders ADD COLUMN notes TEXT` migration, so deploy order
      // cannot take ordering offline.
      try {
        await d1Run(
          env,
          "INSERT INTO orders (id, items, total, payment, type, table_id, customer, status, email, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [...base, notes]
        );
      } catch (e) {
        // SQLite reports exactly: "table orders has no column named notes".
        // Match only that shape — a broader test would swallow unrelated write
        // failures and silently drop the note instead of surfacing the error.
        if (!/has no column named|no such column/i.test(String(e && e.message))) throw e;
        await d1Run(
          env,
          "INSERT INTO orders (id, items, total, payment, type, table_id, customer, status, email) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          base
        );
      }
      const tracking = await insertOrderItems(env, id, data.items, new Date().toISOString());
      return json({ ok: true, id, items: tracking.inserted, warning: tracking.warning || undefined });
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
    if (fields.length === 0) return json({ ok: false, error: "No fields to update" }, 400);
    fields.push("updated_at = ?");
    values.push(nowIso);
    values.push(id);
    const { meta } = await d1Run(env, `UPDATE orders SET ${fields.join(", ")} WHERE id = ?`, values);
    if (!meta.changes) return json({ ok: false, error: "Order not found" }, 404);
    return json({ ok: true, updated_at: nowIso });
  }
  if (m === "DELETE" && sub.startsWith("/")) {
    const id = sub.slice(1);
    const { meta } = await d1Run(env, "DELETE FROM orders WHERE id = ?", [id]);
    if (!meta.changes) return json({ ok: false, error: "Order not found" }, 404);
    return json({ ok: true });
  }
  return null;
}
export { mapOrderRow, handleOrders };
