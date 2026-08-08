import { d1Query, d1Run, json, readBody } from '../lib/db.js';

async function handleReservations(pathname, method, request, env) {
  const m = method.toUpperCase();
  const sub = pathname.replace(/^\/api\/reservations/, "");
  if (m === "GET" && sub === "") {
    const { results } = await d1Query(env, "SELECT * FROM reservations ORDER BY created DESC");
    return json(results || []);
  }
  if (m === "POST" && sub === "") {
    const data = await readBody(request);
    if (!data) return json({ ok: false, error: "Invalid JSON body" }, 400);
    try {
      const id = data.id || "R" + crypto.randomUUID().slice(0, 7);
      await d1Run(
        env,
        'INSERT INTO reservations (id, name, phone, email, "date", "time", guests, table_id, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, String(data.name || ""), String(data.phone || ""), String(data.email || ""), String(data.date || ""), String(data.time || ""), Number(data.guests) || 1, String(data.tableId || data.table_id || ""), String(data.status || "new"), String(data.notes || "")]
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
    if (data.name !== void 0) {
      fields.push("name = ?");
      values.push(data.name);
    }
    if (data.phone !== void 0) {
      fields.push("phone = ?");
      values.push(data.phone);
    }
    if (data.email !== void 0) {
      fields.push("email = ?");
      values.push(data.email);
    }
    if (data.date !== void 0) {
      fields.push("date = ?");
      values.push(data.date);
    }
    if (data.time !== void 0) {
      fields.push("time = ?");
      values.push(data.time);
    }
    if (data.guests !== void 0) {
      fields.push("guests = ?");
      values.push(data.guests);
    }
    if (data.notes !== void 0) {
      fields.push("notes = ?");
      values.push(data.notes);
    }
    if (data.table_id !== void 0 || data.tableId !== void 0) {
      fields.push("table_id = ?");
      values.push(data.table_id || data.tableId || "");
    }
    if (fields.length === 0) return json({ ok: false, error: "No fields to update" }, 400);
    values.push(id);
    const { meta } = await d1Run(env, `UPDATE reservations SET ${fields.join(", ")} WHERE id = ?`, values);
    if (!meta.changes) return json({ ok: false, error: "Reservation not found" }, 404);
    return json({ ok: true });
  }
  if (m === "DELETE" && sub.startsWith("/")) {
    const id = sub.slice(1);
    const { meta } = await d1Run(env, "DELETE FROM reservations WHERE id = ?", [id]);
    if (!meta.changes) return json({ ok: false, error: "Reservation not found" }, 404);
    return json({ ok: true });
  }
  return null;
}
export { handleReservations };
