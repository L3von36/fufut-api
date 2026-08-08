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
      await d1Run(
        env,
        "INSERT INTO orders (id, items, total, payment, type, table_id, customer, status, email) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [id, items, Number(data.total) || 0, data.payment || null, data.order_type || data.type || null, data.tableNum || data.table_number || data.table_id || null, data.name || data.customer || null, data.status || "new", data.email || ""]
      );
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
