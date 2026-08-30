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
      opened: "opened_at",
      closed: "closed_at"
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
  const idPartFull = parts.slice(2).join("/"); // e.g. "CD3a1d1ab/z-report"

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
        // Finding 6 (B+ sim): paid-in / paid-out used to ride the audit log
        // only, so the drawer's `expected` was always `opening + cash_sales`
        // and any paid-in surfaced as unexplained positive variance, any
        // paid-out as unexplained negative variance, at Z-count. The columns
        // are now kept in sync at the paid-in/paid-out handlers, so the
        // expected figure carries them directly.
        const paidIn = Number(drawer.paid_in) || 0;
        const paidOut = Number(drawer.paid_out) || 0;
        const expected = Math.round((opening + cashSales + paidIn - paidOut) * 100) / 100;
        const variance = Math.round((closingBal - expected) * 100) / 100;
        const denoms = data.denominations ? JSON.stringify(data.denominations) : null;

        const { meta } = await d1Run(
          env,
          // closed_at lands with the Z-count (migration 021) so the Z-Report
          // History stops showing each session's opened time under a
          // "Closed Time" header.
          "UPDATE cashdrawers SET closing_balance = ?, expected = ?, variance = ?, status = 'closed', closed_at = ? WHERE id = ?",
          [closingBal, expected, variance, new Date().toISOString(), drawerId]
        );
        if (!meta.changes) return json({ ok: false, error: "Drawer not found or already closed" }, 404);

        await writeAudit(env, auth, {
          action: 'update',
          entity: 'cashdrawer',
          entityId: drawerId,
          before: { status: 'open' },
          after: { closing_balance: closingBal, expected, variance, status: 'closed', paid_in: paidIn, paid_out: paidOut },
          reason: data.notes || (data.denominations ? 'Blind cash count' : 'Drawer close')
        });

        return json({ ok: true, id: drawerId, expected, variance, closingBal, cashSales, paidIn, paidOut });
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

        // Finding 6 (B+ sim): keep the paid_in column on the drawer in sync so
        // the expected-close formula includes it. Fail-open — the audit row is
        // still written so the manager can read the movement even if the column
        // is not yet present (migration 020 not applied).
        try {
          await d1Run(
            env,
            "UPDATE cashdrawers SET paid_in = COALESCE(paid_in, 0) + ? WHERE id = ?",
            [amount, drawer.id]
          );
        } catch (e) {
          console.error('[DRAWER] paid_in column not updated:', e);
        }

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

        // Finding 6 (B+ sim): mirror paid_in — keep the paid_out column on the
        // drawer in sync so the expected-close formula subtracts it. Fail-open
        // for the same reason.
        try {
          await d1Run(
            env,
            "UPDATE cashdrawers SET paid_out = COALESCE(paid_out, 0) + ? WHERE id = ?",
            [amount, drawer.id]
          );
        } catch (e) {
          console.error('[DRAWER] paid_out column not updated:', e);
        }

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

    // ── Z-Report: full fiscal breakdown for a drawer session ────────
    // GET /api/cashdrawer/:id/z-report
    // Joins the drawer with payments, orders, and voids scoped to the
    // drawer's opened_at → closed_at window. Produces:
    // - Header (business, TIN, machine ID, Z-number, session times, operator)
    // - Sales by tax bucket (standard 15%, exempt 0%)
    // - Sales by payment method (cash, telebirr, cbe, bank, card, mobile)
    // - Voids summary (count, total, by category)
    // - Refunds summary (count, total, by method)
    // - Cash reconciliation (opening + cash sales − cash refunds − paid-out)
    // - Service charge + tips totals
    const zrMatch = idPartFull && idPartFull.match(/^([^/]+)\/z-report$/);
    if (zrMatch && m === "GET") {
      const drawerId = zrMatch[1];
      const { results: drawerRows } = await d1Query(
        env, "SELECT * FROM cashdrawers WHERE id = ?", [String(drawerId)]
      );
      const drawer = (drawerRows || [])[0];
      if (!drawer) return json({ ok: false, error: "Drawer not found" }, 404);

      const openedAt = drawer.opened_at || drawer.created;
      const closedAt = drawer.closed_at || new Date().toISOString();

      // ── Payments in the drawer's time window ──────────────────────
      const { results: payRows } = await d1Query(
        env,
        "SELECT * FROM payments WHERE created_at >= ? AND created_at <= ? ORDER BY created_at",
        [openedAt, closedAt]
      );
      const payments = payRows || [];

      // ── Orders in the drawer's time window ────────────────────────
      const { results: orderRows } = await d1Query(
        env,
        "SELECT * FROM orders WHERE created >= ? AND created <= ? ORDER BY created",
        [openedAt, closedAt]
      );
      const orders = orderRows || [];

      // ── Tips in the drawer's time window ──────────────────────────
      const { results: tipRows } = await d1Query(
        env,
        "SELECT * FROM tips WHERE created_at >= ? AND created_at <= ?",
        [openedAt, closedAt]
      );
      const tips = tipRows || [];

      // ── Compute payment method breakdown ─────────────────────────
      const methodMap = {};
      for (const p of payments) {
        if (p.status === 'rejected') continue;
        const method = p.method || 'other';
        const amount = Number(p.amount) || 0;
        if (!methodMap[method]) methodMap[method] = { count: 0, total: 0, refunds: 0, refundCount: 0 };
        if (amount >= 0) {
          methodMap[method].count++;
          methodMap[method].total += amount;
        } else {
          methodMap[method].refundCount++;
          methodMap[method].refunds += Math.abs(amount);
        }
      }
      const paymentBreakdown = Object.entries(methodMap).map(([method, v]) => ({
        method,
        count: v.count,
        total: Math.round(v.total * 100) / 100,
        refundCount: v.refundCount,
        refunds: Math.round(v.refunds * 100) / 100,
        net: Math.round((v.total - v.refunds) * 100) / 100,
      }));

      // ── Compute VAT breakdown ─────────────────────────────────────
      // Ethiopia: 15% standard rate on most food/beverage; 0% exempt
      // (bread, milk). Orders carry a `tax` column; if 0 or null, treat
      // as exempt. If the order has tax > 0, it's standard-rated.
      const VAT_RATE = 0.15;
      let standardGross = 0, standardVat = 0, standardCount = 0;
      let exemptGross = 0, exemptCount = 0;
      for (const o of orders) {
        if (o.voided_at) continue; // voids are reported separately
        const total = Number(o.total) || 0;
        const tax = Number(o.tax) || 0;
        if (tax > 0) {
          standardGross += total;
          standardVat += tax;
          standardCount++;
        } else {
          exemptGross += total;
          exemptCount++;
        }
      }
      // If no tax column is populated (common — the setting is orphaned),
      // treat all sales as standard-rated at 15% (VAT-inclusive extraction).
      if (standardVat === 0 && orders.length > 0) {
        const allGross = orders.filter(o => !o.voided_at).reduce((s, o) => s + (Number(o.total) || 0), 0);
        // VAT-inclusive: net = gross / 1.15, vat = gross − net
        standardGross = allGross;
        standardVat = Math.round((allGross - allGross / 1.15) * 100) / 100;
        standardCount = orders.filter(o => !o.voided_at).length;
        exemptGross = 0;
        exemptCount = 0;
      }

      // ── Voids summary ─────────────────────────────────────────────
      const voidedOrders = orders.filter(o => o.voided_at);
      const voidCategories = {};
      for (const o of voidedOrders) {
        const cat = o.void_category || 'other';
        if (!voidCategories[cat]) voidCategories[cat] = { count: 0, total: 0 };
        voidCategories[cat].count++;
        voidCategories[cat].total += Number(o.total) || 0;
      }
      const voidsSummary = {
        count: voidedOrders.length,
        total: Math.round(voidedOrders.reduce((s, o) => s + (Number(o.total) || 0), 0) * 100) / 100,
        byCategory: Object.entries(voidCategories).map(([cat, v]) => ({
          category: cat, count: v.count, total: Math.round(v.total * 100) / 100,
        })),
      };

      // ── Refunds summary (non-cash) ────────────────────────────────
      const refundPayments = payments.filter(p => p.status === 'refunded' || (Number(p.amount) || 0) < 0);
      const refundByMethod = {};
      for (const r of refundPayments) {
        const method = r.method || 'other';
        if (!refundByMethod[method]) refundByMethod[method] = { count: 0, total: 0 };
        refundByMethod[method].count++;
        refundByMethod[method].total += Math.abs(Number(r.amount) || 0);
      }

      // ── Cash reconciliation ────────────────────────────────────────
      const opening = Number(drawer.opening_balance) || 0;
      const cashSales = Number(drawer.cash_sales) || 0;
      const paidIn = Number(drawer.paid_in) || 0;
      const paidOut = Number(drawer.paid_out) || 0;
      const closing = Number(drawer.closing_balance) || 0;
      const expected = Math.round((opening + cashSales + paidIn - paidOut) * 100) / 100;
      const variance = Math.round((closing - expected) * 100) / 100;

      // ── Service charge + tips ─────────────────────────────────────
      const serviceChargeTotal = orders
        .filter(o => !o.voided_at)
        .reduce((s, o) => s + (Number(o.service_charge) || 0), 0);
      const tipsTotal = tips.reduce((s, t) => s + (Number(t.amount) || 0), 0);

      // ── Cumulative grand totals (all closed drawers) ──────────────
      const { results: allClosed } = await d1Query(
        env, "SELECT COUNT(*) as count, SUM(cash_sales) as total FROM cashdrawers WHERE status = 'closed'"
      );
      const grandTotal = (allClosed && allClosed[0]) || { count: 0, total: 0 };

      // ── Z-number: sequential number for this drawer ───────────────
      const { results: zCount } = await d1Query(
        env, "SELECT COUNT(*) as count FROM cashdrawers WHERE status = 'closed' AND created <= ?",
        [drawer.created]
      );
      const zNumber = ((zCount && zCount[0] && zCount[0].count) || 0);

      return json({
        ok: true,
        header: {
          zNumber,
          drawerId: drawer.id,
          openedAt,
          closedAt: drawer.closed_at || null,
          status: drawer.status,
          // Business fields — populated from settings if available, else blank
          businessName: null, // TODO: read from settings
          tin: null,          // TODO: read from settings
          vatRate: VAT_RATE,
        },
        vatBreakdown: {
          standard: { rate: VAT_RATE, gross: Math.round(standardGross * 100) / 100, vat: Math.round(standardVat * 100) / 100, count: standardCount },
          exempt: { rate: 0, gross: Math.round(exemptGross * 100) / 100, count: exemptCount },
          totalGross: Math.round((standardGross + exemptGross) * 100) / 100,
          totalVat: Math.round(standardVat * 100) / 100,
        },
        paymentBreakdown,
        voids: voidsSummary,
        refunds: {
          count: refundPayments.length,
          total: Math.round(refundPayments.reduce((s, r) => s + Math.abs(Number(r.amount) || 0), 0) * 100) / 100,
          byMethod: Object.entries(refundByMethod).map(([method, v]) => ({
            method, count: v.count, total: Math.round(v.total * 100) / 100,
          })),
        },
        cashReconciliation: {
          openingFloat: Math.round(opening * 100) / 100,
          cashSales: Math.round(cashSales * 100) / 100,
          paidIn: Math.round(paidIn * 100) / 100,
          paidOut: Math.round(paidOut * 100) / 100,
          expected: Math.round(expected * 100) / 100,
          counted: Math.round(closing * 100) / 100,
          variance: Math.round(variance * 100) / 100,
        },
        serviceCharge: Math.round(serviceChargeTotal * 100) / 100,
        tips: Math.round(tipsTotal * 100) / 100,
        grandTotals: {
          zCount: grandTotal.count || 0,
          cumulativeCashSales: Math.round((grandTotal.total || 0) * 100) / 100,
        },
        receiptRange: {
          firstReceipt: orders.length ? orders[0].id : null,
          lastReceipt: orders.length ? orders[orders.length - 1].id : null,
          totalReceipts: orders.filter(o => !o.voided_at).length,
        },
      });
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
