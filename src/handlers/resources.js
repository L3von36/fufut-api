import { d1Query, d1Run, json, now, readBody } from '../lib/db.js';
import { writeAudit } from '../lib/audit.js';

var RESOURCE_MAP = {
  tables: { table: "tables", readMap: {} },
  staff: { table: "staff", readMap: {} },
  expenses: { table: "expenses", readMap: {} },
  inventory: { table: "inventory", readMap: { quantity: "stock", minLevel: "min_level" } },
  delivery: { table: "delivery", readMap: {} },
  waste: { table: "waste", readMap: {} },
  timeclock: { table: "timeclock", readMap: {} },
  shifts: { table: "shifts", readMap: {} },
  cashdrawer: {
    table: "cashdrawers",
    readMap: {
      openingBal: "opening_balance",
      closingBal: "closing_balance",
      cashSales: "cash_sales",
      expectedClose: "expected",
      opened: "opened_at"
    }
  }
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

async function handleResources(pathname, method, url, request, env, auth) {
  const m = method.toUpperCase();
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 2 || parts[0] !== "api") return null;
  const res = parts[1];
  const cfg = RESOURCE_MAP[res];
  if (!cfg) return null;
  const table = cfg.table;
  const idPart = parts[2] || "";

  // ── Cashier Cashdrawer Sub-Routes ─────────────────────────────────────────
  if (res === "cashdrawer") {
    if (idPart === "open" && m === "POST") {
      const data = (await readBody(request)) || {};
      const id = "CD" + crypto.randomUUID().slice(0, 7);
      const openingBal = Number(data.openingBal) || 0;
      try {
        await d1Run(
          env,
          "INSERT INTO cashdrawers (id, opened_at, opening_balance, cash_sales, status, created) VALUES (?, ?, ?, 0, 'open', ?)",
          [id, now(), openingBal, now()]
        );
        await writeAudit(env, auth, {
          action: 'create',
          entity: 'cashdrawer',
          entityId: id,
          after: { opening_balance: openingBal, status: 'open' }
        });
        return json({ ok: true, id });
      } catch (e) {
        return json({ ok: false, error: String(e.message || e) }, 500);
      }
    }

    if (idPart === "close" && m === "POST") {
      const data = (await readBody(request)) || {};
      const closingBal = Number(data.closingBal) || 0;
      const targetId = String(data.id || '');
      try {
        const { results } = await d1Query(
          env,
          "SELECT * FROM cashdrawers WHERE (id = ? OR status = 'open') ORDER BY created DESC LIMIT 1",
          [targetId]
        );
        const drawer = results && results[0];
        if (!drawer) return json({ ok: false, error: "No open drawer found to close" }, 404);

        const drawerId = drawer.id;
        const opening = Number(drawer.opening_balance) || 0;
        const cashSales = Number(drawer.cash_sales) || 0;
        const expected = opening + cashSales;
        const variance = Math.round((closingBal - expected) * 100) / 100;
        const denoms = data.denominations ? JSON.stringify(data.denominations) : null;

        const { meta } = await d1Run(
          env,
          "UPDATE cashdrawers SET closing_balance = ?, expected = ?, variance = ?, status = 'closed' WHERE id = ?",
          [closingBal, expected, variance, drawerId]
        );
        if (!meta.changes) return json({ ok: false, error: "Drawer not found or already closed" }, 404);

        await writeAudit(env, auth, {
          action: 'update',
          entity: 'cashdrawer',
          entityId: drawerId,
          before: { status: 'open' },
          after: { closing_balance: closingBal, expected, variance, status: 'closed' },
          reason: data.notes || (data.denominations ? 'Blind cash count' : 'Drawer close')
        });

        return json({ ok: true, id: drawerId, expected, variance, closingBal, cashSales });
      } catch (e) {
        return json({ ok: false, error: String(e.message || e) }, 500);
      }
    }

    if (idPart === "paid-in" && m === "POST") {
      const data = (await readBody(request)) || {};
      const amount = Number(data.amount) || 0;
      if (amount <= 0) return json({ ok: false, error: "Paid-in amount must be greater than zero" }, 400);
      if (!data.reason || !data.reason.trim()) return json({ ok: false, error: "Reason is required for paid-in" }, 400);

      try {
        const { results } = await d1Query(env, "SELECT * FROM cashdrawers WHERE status = 'open' ORDER BY created DESC LIMIT 1");
        const drawer = results && results[0];
        if (!drawer) return json({ ok: false, error: "No active cash drawer open" }, 400);

        await writeAudit(env, auth, {
          action: 'paid_in',
          entity: 'cashdrawer',
          entityId: drawer.id,
          after: { amount, reason: data.reason.trim() },
          reason: data.reason.trim()
        });

        return json({ ok: true, drawerId: drawer.id, amount, reason: data.reason.trim() });
      } catch (e) {
        return json({ ok: false, error: String(e.message || e) }, 500);
      }
    }

    if (idPart === "paid-out" && m === "POST") {
      const data = (await readBody(request)) || {};
      const amount = Number(data.amount) || 0;
      if (amount <= 0) return json({ ok: false, error: "Paid-out amount must be greater than zero" }, 400);
      if (!data.reason || !data.reason.trim()) return json({ ok: false, error: "Reason is required for petty cash paid-out" }, 400);

      try {
        const { results } = await d1Query(env, "SELECT * FROM cashdrawers WHERE status = 'open' ORDER BY created DESC LIMIT 1");
        const drawer = results && results[0];
        if (!drawer) return json({ ok: false, error: "No active cash drawer open" }, 400);

        await writeAudit(env, auth, {
          action: 'paid_out',
          entity: 'cashdrawer',
          entityId: drawer.id,
          after: { amount, reason: data.reason.trim() },
          reason: data.reason.trim()
        });

        return json({ ok: true, drawerId: drawer.id, amount, reason: data.reason.trim() });
      } catch (e) {
        return json({ ok: false, error: String(e.message || e) }, 500);
      }
    }

    if (idPart === "pop" && m === "POST") {
      const data = (await readBody(request)) || {};
      const reason = (data.reason || "Manual drawer open").trim();

      try {
        const { results } = await d1Query(env, "SELECT * FROM cashdrawers WHERE status = 'open' ORDER BY created DESC LIMIT 1");
        const drawer = results && results[0];

        await writeAudit(env, auth, {
          action: 'drawer_pop',
          entity: 'cashdrawer',
          entityId: drawer ? drawer.id : 'manual',
          reason
        });

        return json({ ok: true, reason });
      } catch (e) {
        return json({ ok: false, error: String(e.message || e) }, 500);
      }
    }

    if (idPart === "shift-log" && m === "GET") {
      try {
        const { results } = await d1Query(
          env,
          `SELECT * FROM audit_log 
            WHERE entity IN ('cashdrawer', 'timeclock', 'payments', 'orders')
            ORDER BY at DESC LIMIT 100`
        );
        const entries = (results || []).map((r) => {
          const parse = (v) => { if (!v) return null; try { return JSON.parse(v); } catch { return v; } };
          return { ...r, before: parse(r.before), after: parse(r.after) };
        });
        return json({ ok: true, count: entries.length, entries });
      } catch (e) {
        return json({ ok: false, error: String(e.message || e) }, 500);
      }
    }

    if (idPart === "history" && m === "GET") {
      try {
        const { results } = await d1Query(env, "SELECT * FROM cashdrawers WHERE status = 'closed' ORDER BY created DESC LIMIT 50");
        const drawers = (results || []).map((r) => mapResourceRow("cashdrawer", r));
        return json({ ok: true, drawers });
      } catch (e) {
        return json({ ok: false, error: String(e.message || e) }, 500);
      }
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
    if (res === "cashdrawer") {
      const active = rows.find(d => d.status === "open") || null;
      return json({ ok: true, drawers: rows, active, data: rows });
    }
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
