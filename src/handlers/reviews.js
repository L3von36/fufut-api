import { d1Query, d1Run, json, readBody } from '../lib/db.js';

async function handleReviews(pathname, method, request, env) {
  const m = method.toUpperCase();
  const sub = pathname.replace(/^\/api\/reviews/, "");
  if (m === "GET" && sub === "") {
    const { results } = await d1Query(env, "SELECT * FROM reviews ORDER BY created DESC");
    return json(results || []);
  }
  if (m === "POST" && sub === "") {
    const data = await readBody(request);
    if (!data) return json({ ok: false, error: "Invalid JSON body" }, 400);
    const id = data.id || "RV" + crypto.randomUUID().slice(0, 7);
    const dateVal = data.date || (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
    await d1Run(
      env,
      "INSERT INTO reviews (id, author, text, rating, status, date) VALUES (?, ?, ?, ?, ?, ?)",
      [id, data.author || data.name || "", data.text || data.review || "", data.rating || 5, data.status || "pending", dateVal]
    );
    return json({ ok: true, id });
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
    if (data.author !== void 0) {
      fields.push("author = ?");
      values.push(data.author);
    }
    if (data.text !== void 0) {
      fields.push("text = ?");
      values.push(data.text);
    }
    if (data.rating !== void 0) {
      fields.push("rating = ?");
      values.push(data.rating);
    }
    if (data.date !== void 0) {
      fields.push("date = ?");
      values.push(data.date);
    }
    if (fields.length === 0) return json({ ok: false, error: "No fields to update" }, 400);
    values.push(id);
    const { meta } = await d1Run(env, `UPDATE reviews SET ${fields.join(", ")} WHERE id = ?`, values);
    if (!meta.changes) return json({ ok: false, error: "Review not found" }, 404);
    return json({ ok: true });
  }
  if (m === "DELETE" && sub.startsWith("/")) {
    const id = sub.slice(1);
    const { meta } = await d1Run(env, "DELETE FROM reviews WHERE id = ?", [id]);
    if (!meta.changes) return json({ ok: false, error: "Review not found" }, 404);
    return json({ ok: true });
  }
  return null;
}
export { handleReviews };
