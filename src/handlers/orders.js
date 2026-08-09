import { d1Query, d1Run, json, readBody } from '../lib/db.js';

function mapOrderRow(o) {
  const tn = o.table_id || o.table_number || o.tableNum || null;
  return Object.assign({}, o, { tableNum: tn, table_number: tn });
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
      return json({ ok: true, id });
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 500);
    }
  }
  if (m === "PUT" && sub.startsWith("/")) {
    const id = sub.slice(1);
    const data = await readBody(request);
    if (!data) return json({ ok: false, error: "Invalid JSON body" }, 400);
    const fields = [];
    const values = [];
    if (data.status !== void 0) {
      fields.push("status = ?");
      values.push(data.status);
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
    values.push(id);
    const { meta } = await d1Run(env, `UPDATE orders SET ${fields.join(", ")} WHERE id = ?`, values);
    if (!meta.changes) return json({ ok: false, error: "Order not found" }, 404);
    return json({ ok: true });
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
