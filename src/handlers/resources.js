import { d1Query, d1Run, json, now, readBody } from '../lib/db.js';

var RESOURCE_MAP = {
  tables: { table: "tables", readMap: {} },
  staff: { table: "staff", readMap: {} },
  expenses: { table: "expenses", readMap: {} },
  inventory: { table: "inventory", readMap: { quantity: "stock", minLevel: "min_level" } },
  delivery: { table: "delivery", readMap: {} },
  waste: { table: "waste", readMap: {} },
  timeclock: { table: "timeclock", readMap: {} },
  shifts: { table: "shifts", readMap: {} },
  cashdrawer: { table: "cashdrawers", readMap: {} }
};

async function tableColumns(env, table) {
  const { results } = await d1Query(env, "PRAGMA table_info(" + table + ")");
  return (results || []).map((c) => c.name);
}

function mapResourceRow(res, row) {
  let out = row;
  const cfg = RESOURCE_MAP[res];
  if (cfg && cfg.readMap) {
    out = Object.assign({}, row);
    for (const k in cfg.readMap) {
      if (out[cfg.readMap[k]] !== void 0 && out[k] === void 0) out[k] = out[cfg.readMap[k]];
    }
  }
  if (res === "staff") {
    out = Object.assign({}, out);
    delete out.password_hash;
  }
  return out;
}

function resourceIdPrefix(res) {
  const p = { tables: "T", staff: "S", expenses: "E", inventory: "I", delivery: "DL", waste: "W", timeclock: "TC", shifts: "SH", cashdrawer: "CD" };
  return p[res] || "X";
}

async function handleResources(pathname, method, url, request, env) {
  const m = method.toUpperCase();
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 2 || parts[0] !== "api") return null;
  const res = parts[1];
  const cfg = RESOURCE_MAP[res];
  if (!cfg) return null;
  const table = cfg.table;
  const idPart = parts[2] || "";
  if (res === "cashdrawer" && idPart === "open" && m === "POST") {
    const data = await readBody(request);
    if (!data) return json({ ok: false, error: "Invalid JSON body" }, 400);
    const id = "CD" + crypto.randomUUID().slice(0, 7);
    try {
      await d1Run(
        env,
        "INSERT INTO cashdrawers (id, opened_at, opening_balance, cash_sales, status, created) VALUES (?, ?, ?, ?, 'open', ?)",
        [id, now(), Number(data.openingBal) || 0, 0, now()]
      );
      return json({ ok: true, id });
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 500);
    }
  }
  if (res === "cashdrawer" && idPart === "close" && m === "POST") {
    const data = await readBody(request);
    if (!data) return json({ ok: false, error: "Invalid JSON body" }, 400);
    const closingBal = Number(data.closingBal) || 0;
    try {
      const { results } = await d1Query(env, "SELECT opening_balance FROM cashdrawers WHERE id = ?", [String(data.id)]);
      const opening = results && results.length ? Number(results[0].opening_balance) || 0 : 0;
      const variance = Math.round((closingBal - opening) * 100) / 100;
      const { meta } = await d1Run(
        env,
        "UPDATE cashdrawers SET closing_balance = ?, expected = ?, variance = ?, status = 'closed' WHERE id = ? AND status = 'open'",
        [closingBal, opening, variance, String(data.id)]
      );
      if (!meta.changes) return json({ ok: false, error: "Drawer not found or already closed" }, 404);
      return json({ ok: true });
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 500);
    }
  }
  let cols = [];
  try {
    cols = await tableColumns(env, table);
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
  if (m === "GET" && !idPart) {
    const { results } = await d1Query(env, "SELECT * FROM " + table + " ORDER BY created DESC");
    const rows = (results || []).map((r) => mapResourceRow(res, r));
    return json(rows);
  }
  if (m === "POST" && !idPart) {
    const data = await readBody(request);
    if (!data) return json({ ok: false, error: "Invalid JSON body" }, 400);
    const id = data.id || resourceIdPrefix(res) + crypto.randomUUID().slice(0, 7);
    const entry = Object.assign({}, data, { id });
    if (entry.created === void 0) entry.created = now();
    const filtered = {};
    for (const c of cols) {
      if (entry[c] !== void 0) filtered[c] = entry[c];
    }
    if (Object.keys(filtered).length === 0) return json({ ok: false, error: "No valid fields" }, 400);
    const colNames = Object.keys(filtered).join(", ");
    const placeholders = Object.keys(filtered).map(() => "?").join(", ");
    const values = Object.values(filtered).map((v) => typeof v === "object" && v !== null ? JSON.stringify(v) : v);
    try {
      await d1Run(env, "INSERT INTO " + table + " (" + colNames + ") VALUES (" + placeholders + ")", values);
      return json({ ok: true, id });
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 500);
    }
  }
  if (m === "PUT") {
    const data = await readBody(request);
    if (!data) return json({ ok: false, error: "Invalid JSON body" }, 400);
    const itemId = idPart || data.id;
    if (!itemId) return json({ ok: false, error: "id required" }, 400);
    const filtered = {};
    for (const c of cols) {
      if (c !== "id" && c !== "created" && data[c] !== void 0) filtered[c] = data[c];
    }
    if (Object.keys(filtered).length === 0) return json({ ok: false, error: "No fields to update" }, 400);
    const setClause = Object.keys(filtered).map((c) => c + " = ?").join(", ");
    const values = Object.values(filtered).map((v) => typeof v === "object" && v !== null ? JSON.stringify(v) : v);
    values.push(String(itemId));
    try {
      const { meta } = await d1Run(env, "UPDATE " + table + " SET " + setClause + " WHERE id = ?", values);
      if (!meta.changes) return json({ ok: false, error: "item not found" }, 404);
      return json({ ok: true });
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 500);
    }
  }
  if (m === "DELETE") {
    let body = null;
    try {
      body = await readBody(request);
    } catch (e) {
    }
    const itemId = idPart || body && body.id;
    if (!itemId) return json({ ok: false, error: "id required" }, 400);
    try {
      const { meta } = await d1Run(env, "DELETE FROM " + table + " WHERE id = ?", [String(itemId)]);
      if (!meta.changes) return json({ ok: false, error: "item not found" }, 404);
      return json({ ok: true });
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 500);
    }
  }
  return null;
}
export { RESOURCE_MAP, tableColumns, mapResourceRow, resourceIdPrefix, handleResources };
