/**
 * Management reporting — §48, §49, §50, §51 and §61.
 *
 * ── The one rule every figure here obeys ────────────────────────────────────
 *
 * **Net sales is `total - tip`.** `orders.total` includes the tip because it is
 * what the guest hands over, and a tip is not the restaurant's money. Every
 * revenue number below subtracts it, and `tips` is reported as its own line so
 * it is visible without ever being counted as trading income.
 *
 * A voided order is excluded everywhere. It stays in the database — §37
 * requires that — but it did not happen commercially, and including it would
 * overstate the day.
 *
 * ── Why the queries aggregate in SQL ────────────────────────────────────────
 *
 * Fetching a day of orders and summing them in the Worker works until it
 * doesn't; these run against a year without changing shape. The cost is that
 * the arithmetic is in strings, so the one calculation with real subtlety —
 * separating the tip out — is written once in `NET_SALES` and reused.
 */

import { d1Query, json } from '../lib/db.js';

/**
 * Net trading revenue. COALESCE because rows written before migration 005 have
 * a NULL tip, and `total - NULL` is NULL in SQL — which would silently drop
 * every historical order out of the totals.
 */
const NET_SALES = 'SUM(COALESCE(o.total, 0) - COALESCE(o.tip, 0))';

/** Orders that count commercially. */
const REAL_ORDERS = "o.voided_at IS NULL AND o.status <> 'cancelled'";

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function round2(n) {
  return Math.round(num(n) * 100) / 100;
}

/**
 * Resolve a reporting window.
 *
 * `orders.created` is a local timestamp ("2026-08-06 01:55:46"), not UTC — the
 * POS's TODAY() comment records why that matters — so the window is compared as
 * a date prefix rather than as an instant. Addis is UTC+3, and using an ISO
 * instant here would file every order between midnight and 03:00 under the
 * previous day.
 */
function resolveWindow(url) {
  const period = url.searchParams.get('period');
  const explicitFrom = url.searchParams.get('from');
  const explicitTo = url.searchParams.get('to');
  if (explicitFrom || explicitTo) {
    return { from: explicitFrom || '0000-01-01', to: explicitTo || '9999-12-31', period: 'custom' };
  }

  const now = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const todayStr = iso(now);

  if (period === 'week') {
    const d = new Date(now);
    d.setDate(d.getDate() - 6);
    return { from: iso(d), to: todayStr, period: 'week' };
  }
  if (period === 'month') {
    const d = new Date(now);
    d.setDate(d.getDate() - 29);
    return { from: iso(d), to: todayStr, period: 'month' };
  }
  return { from: todayStr, to: todayStr, period: 'day' };
}

/** `created` is a local timestamp, so compare on its date prefix. */
const DATE_CLAUSE = "date(o.created) >= ? AND date(o.created) <= ?";

// ── Dashboard (§48) ─────────────────────────────────────────────────────────

async function dashboard(env, url) {
  const { from, to, period } = resolveWindow(url);
  const w = [from, to];

  const [
    headline, byType, byCategory, payMethods, tipTotal,
    expenseTotal, lowStock, pendingKitchen, pendingDelivery, supplierBalance,
  ] = await Promise.all([
    d1Query(env, `SELECT COUNT(*) AS orders, ${NET_SALES} AS net, SUM(COALESCE(o.tip,0)) AS tips,
                         SUM(COALESCE(o.discount,0)) AS discounts
                    FROM orders o WHERE ${REAL_ORDERS} AND ${DATE_CLAUSE}`, w),

    d1Query(env, `SELECT COALESCE(o.type,'unknown') AS type, COUNT(*) AS orders, ${NET_SALES} AS net
                    FROM orders o WHERE ${REAL_ORDERS} AND ${DATE_CLAUSE}
                   GROUP BY o.type`, w),

    // Category revenue comes from the tracked lines, which are the only place a
    // dish's category is recorded at the moment it was sold.
    d1Query(env, `SELECT COALESCE(oi.category,'Uncategorised') AS category,
                         SUM(oi.qty) AS qty,
                         SUM(oi.qty * oi.unit_price) AS revenue
                    FROM order_items oi JOIN orders o ON o.id = oi.order_id
                   WHERE ${REAL_ORDERS} AND oi.status <> 'cancelled' AND ${DATE_CLAUSE}
                   GROUP BY oi.category ORDER BY revenue DESC`, w),

    d1Query(env, `SELECT p.method, COUNT(*) AS count, SUM(p.amount) AS total
                    FROM payments p JOIN orders o ON o.id = p.order_id
                   WHERE p.status <> 'rejected' AND ${REAL_ORDERS} AND ${DATE_CLAUSE}
                   GROUP BY p.method ORDER BY total DESC`, w).catch(() => ({ results: [] })),

    d1Query(env, "SELECT SUM(amount) AS total FROM tips WHERE date >= ? AND date <= ? AND COALESCE(status, 'recorded') <> 'refunded'", w)
      .catch(() => ({ results: [] })),

    d1Query(env, 'SELECT SUM(amount) AS total FROM expenses WHERE date >= ? AND date <= ?', w)
      .catch(() => ({ results: [] })),

    d1Query(env, `SELECT COUNT(*) AS n FROM inventory
                   WHERE (active IS NULL OR active = 1)
                     AND stock <= COALESCE(reorder_point, min_level, 0)`)
      .catch(() => ({ results: [] })),

    d1Query(env, `SELECT COUNT(*) AS n FROM orders o
                   WHERE o.status IN ('new','preparing') AND ${REAL_ORDERS}`),

    d1Query(env, `SELECT COUNT(*) AS n FROM delivery
                   WHERE status NOT IN ('delivered','cancelled')`).catch(() => ({ results: [] })),

    d1Query(env, `SELECT SUM(total - paid) AS owed FROM purchases WHERE voided_at IS NULL`)
      .catch(() => ({ results: [] })),
  ]);

  const h = (headline.results && headline.results[0]) || {};
  const first = (r, key, d = 0) => num(r.results && r.results[0] && r.results[0][key], d);

  const typeRow = (t) => {
    const row = (byType.results || []).find((r) => r.type === t);
    return { orders: num(row && row.orders), net: round2(row && row.net) };
  };

  const netSales = round2(h.net);
  const expenses = first(expenseTotal, 'total');

  return json({
    ok: true,
    period,
    from,
    to,
    sales: {
      orders: num(h.orders),
      // Named `netSales`, not `revenue`, so nothing downstream can mistake it
      // for a figure that includes the tips.
      netSales,
      discounts: round2(h.discounts),
      averageOrder: num(h.orders) ? round2(netSales / num(h.orders)) : 0,
    },
    byOrderType: {
      dineIn: typeRow('dine-in'),
      takeaway: typeRow('takeaway'),
      delivery: typeRow('delivery'),
    },
    byCategory: (byCategory.results || []).map((r) => ({
      category: r.category,
      quantity: num(r.qty),
      revenue: round2(r.revenue),
    })),
    paymentMethods: (payMethods.results || []).map((r) => ({
      method: r.method,
      count: num(r.count),
      total: round2(r.total),
    })),
    // Its own line, never inside netSales.
    tips: round2(first(tipTotal, 'total')),
    expenses: round2(expenses),
    // Trading margin before labour, rent and utilities — deliberately not
    // called profit, because those costs are not in it.
    grossOfExpenses: round2(netSales - expenses),
    operations: {
      lowStockItems: first(lowStock, 'n'),
      pendingKitchenOrders: first(pendingKitchen, 'n'),
      pendingDeliveries: first(pendingDelivery, 'n'),
    },
    supplierBalance: round2(first(supplierBalance, 'owed')),
  });
}

// ── Product performance (§49) ───────────────────────────────────────────────

async function productPerformance(env, url) {
  const { from, to, period } = resolveWindow(url);
  const w = [from, to];

  const { results } = await d1Query(
    env,
    `SELECT oi.name,
            COALESCE(oi.category,'Uncategorised') AS category,
            SUM(oi.qty)                          AS quantity,
            SUM(oi.qty * oi.unit_price)          AS revenue,
            SUM(COALESCE(oi.ingredient_cost,0) + COALESCE(oi.packaging_cost,0)) AS cost,
            COUNT(DISTINCT oi.order_id)          AS appearances
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE ${REAL_ORDERS} AND oi.status <> 'cancelled' AND ${DATE_CLAUSE}
      GROUP BY oi.name, oi.category
      ORDER BY quantity DESC`,
    w
  );

  const products = (results || []).map((r) => {
    const revenue = round2(r.revenue);
    // Cost is only present once a recipe existed at the time of sale. Reporting
    // a 100% margin for an uncosted dish would be worse than reporting none.
    const cost = num(r.cost);
    const costed = cost > 0;
    return {
      name: r.name,
      category: r.category,
      quantity: num(r.quantity),
      revenue,
      ingredientCost: costed ? round2(cost) : null,
      grossMargin: costed ? round2(revenue - cost) : null,
      grossMarginPct: costed && revenue > 0 ? Math.round(((revenue - cost) / revenue) * 1000) / 10 : null,
      appearances: num(r.appearances),
    };
  });

  const costed = products.filter((p) => p.grossMargin !== null);

  return json({
    ok: true, period, from, to,
    products,
    best: products.slice(0, 10),
    worst: [...products].reverse().slice(0, 10),
    mostProfitable: [...costed].sort((a, b) => b.grossMargin - a.grossMargin).slice(0, 10),
    highestCost: [...costed].sort((a, b) => b.ingredientCost - a.ingredientCost).slice(0, 10),
    uncosted: products.filter((p) => p.grossMargin === null).map((p) => p.name),
  });
}

// ── Financial summary (§50) ─────────────────────────────────────────────────

async function financial(env, url) {
  const { from, to, period } = resolveWindow(url);
  const w = [from, to];

  const [income, expensesByCat, payMethods, tipTotal, purchases, cogs] = await Promise.all([
    d1Query(env, `SELECT COALESCE(o.type,'unknown') AS type, ${NET_SALES} AS net, COUNT(*) AS orders
                    FROM orders o WHERE ${REAL_ORDERS} AND ${DATE_CLAUSE} GROUP BY o.type`, w),
    d1Query(env, `SELECT COALESCE(category,'Uncategorised') AS category, SUM(amount) AS total
                    FROM expenses WHERE date >= ? AND date <= ?
                     AND (voided_at IS NULL OR voided_at = '')
                   GROUP BY category ORDER BY total DESC`, w).catch(() => ({ results: [] })),
    d1Query(env, `SELECT p.method, SUM(p.amount) AS total FROM payments p
                    JOIN orders o ON o.id = p.order_id
                   WHERE p.status <> 'rejected' AND ${REAL_ORDERS} AND ${DATE_CLAUSE}
                   GROUP BY p.method`, w).catch(() => ({ results: [] })),
    d1Query(env, "SELECT SUM(amount) AS total FROM tips WHERE date >= ? AND date <= ? AND COALESCE(status, 'recorded') <> 'refunded'", w)
      .catch(() => ({ results: [] })),
    d1Query(env, `SELECT SUM(total) AS total, SUM(total - paid) AS owed FROM purchases
                   WHERE voided_at IS NULL AND date >= ? AND date <= ?`, w).catch(() => ({ results: [] })),
    // Cost of what was actually sold, from the snapshots taken at consumption.
    d1Query(env, `SELECT SUM(COALESCE(oi.ingredient_cost,0) + COALESCE(oi.packaging_cost,0)) AS total
                    FROM order_items oi JOIN orders o ON o.id = oi.order_id
                   WHERE ${REAL_ORDERS} AND oi.status <> 'cancelled' AND ${DATE_CLAUSE}`, w)
      .catch(() => ({ results: [] })),
  ]);

  const first = (r, key) => num(r.results && r.results[0] && r.results[0][key]);
  const incomeRows = (income.results || []).map((r) => ({
    source: r.type, orders: num(r.orders), net: round2(r.net),
  }));
  const totalIncome = round2(incomeRows.reduce((s, r) => s + r.net, 0));
  const expenseRows = (expensesByCat.results || []).map((r) => ({
    category: r.category, total: round2(r.total),
  }));
  const totalExpenses = round2(expenseRows.reduce((s, r) => s + r.total, 0));
  const costOfSales = round2(first(cogs, 'total'));

  return json({
    ok: true, period, from, to,
    income: { byType: incomeRows, total: totalIncome },
    expenses: { byCategory: expenseRows, total: totalExpenses },
    purchases: { total: round2(first(purchases, 'total')), outstanding: round2(first(purchases, 'owed')) },
    paymentMethods: (payMethods.results || []).map((r) => ({ method: r.method, total: round2(r.total) })),
    tips: {
      total: round2(first(tipTotal, 'total')),
      note: 'Staff money. Not included in income.',
    },
    margins: {
      costOfSales,
      // Ingredients and packaging only. Everything else is below this line.
      grossMargin: costOfSales > 0 ? round2(totalIncome - costOfSales) : null,
      grossMarginPct: costOfSales > 0 && totalIncome > 0
        ? Math.round(((totalIncome - costOfSales) / totalIncome) * 1000) / 10
        : null,
      afterExpenses: round2(totalIncome - costOfSales - totalExpenses),
    },
    // Stated in the payload so no screen can render these numbers as profit.
    disclaimer:
      'Gross margin covers ingredients and packaging only. Labour, rent, utilities and tax are not deducted, so none of these figures is net profit.',
  });
}

// ── Accountant export (§51) ─────────────────────────────────────────────────

/**
 * GET /api/reports/accountant?from=&to=
 *
 * Everything §51 lists, in one payload, so the monthly hand-over is a download
 * rather than eleven screenshots. Deliberately raw rows: the accountant's own
 * software will re-aggregate, and a pre-summarised export is one they cannot
 * check.
 */
async function accountantExport(env, url) {
  const { from, to } = resolveWindow(url);
  const w = [from, to];

  const q = (sql, params = w) => d1Query(env, sql, params).catch(() => ({ results: [] }));

  const [sales, payments, expenses, purchases, suppliers, tips, attendance, overtime, leave, payroll] =
    await Promise.all([
      q(`SELECT o.id, o.created, o.type, o.subtotal, o.discount, o.tip, o.total,
                o.payment_status, o.customer
           FROM orders o WHERE ${REAL_ORDERS} AND ${DATE_CLAUSE} ORDER BY o.created`),
      q(`SELECT p.* FROM payments p JOIN orders o ON o.id = p.order_id
          WHERE p.status <> 'rejected' AND ${DATE_CLAUSE} ORDER BY p.created_at`),
      q('SELECT * FROM expenses WHERE date >= ? AND date <= ? ORDER BY date'),
      q('SELECT * FROM purchases WHERE voided_at IS NULL AND date >= ? AND date <= ? ORDER BY date'),
      q(`SELECT s.id, s.name, s.category,
                COALESCE(SUM(p.total - p.paid), 0) AS balance
           FROM suppliers s LEFT JOIN purchases p
             ON p.supplier_id = s.id AND p.voided_at IS NULL
          GROUP BY s.id HAVING balance <> 0`, []),
      q('SELECT * FROM tips WHERE date >= ? AND date <= ? ORDER BY date'),
      q(`SELECT staff_id, date, clock_in, clock_out, hours, attendance_status,
                late_minutes, early_leave_minutes
           FROM timeclock WHERE date >= ? AND date <= ? ORDER BY date`),
      q("SELECT * FROM overtime WHERE status = 'approved' AND date >= ? AND date <= ? ORDER BY date"),
      q('SELECT * FROM leave_requests WHERE start_date <= ? AND end_date >= ? ORDER BY start_date', [to, from]),
      q(`SELECT r.period_start, r.period_end, r.provisional, l.*
           FROM payroll_lines l JOIN payroll_runs r ON r.id = l.run_id
          WHERE r.period_start >= ? AND r.period_end <= ?`),
    ]);

  const rows = (r) => r.results || [];

  return json({
    ok: true,
    generatedAt: new Date().toISOString(),
    period: { from, to },
    sales: rows(sales),
    payments: rows(payments),
    expenses: rows(expenses),
    supplierPurchases: rows(purchases),
    supplierBalances: rows(suppliers),
    // Listed separately and labelled, so it cannot be filed as trading income.
    tips: rows(tips),
    attendance: rows(attendance),
    overtime: rows(overtime),
    leave: rows(leave),
    payroll: rows(payroll),
    notes: [
      'Order totals include tips. Trading income is total minus tip.',
      'Tips are staff money and are listed separately from sales.',
      'Voided and cancelled orders are excluded.',
      'Payroll figures are provisional wherever `provisional` is 1 — the tax and pension rates behind them have not been confirmed.',
    ],
  });
}

// ── The questions in §61 ────────────────────────────────────────────────────

/**
 * GET /api/reports/ingredient/:id — everything §61 asks about one raw material,
 * answered from the ledger in a single response.
 *
 * "How much did we buy, how much should the sales have consumed, how much
 * should be left, how much is actually there, what is the difference, how long
 * will it last." Each of those is a separate query elsewhere; a manager asking
 * about coffee wants them together.
 */
async function ingredientAnswers(env, url, id) {
  const { from, to } = resolveWindow(url);

  const [{ results: items }, { results: moves }, { results: recipes }] = await Promise.all([
    d1Query(env, 'SELECT * FROM inventory WHERE id = ?', [id]),
    d1Query(
      env,
      `SELECT type, SUM(qty) AS qty FROM stock_movements
        WHERE inventory_id = ? AND date(at) >= ? AND date(at) <= ? GROUP BY type`,
      [id, from, to]
    ).catch(() => ({ results: [] })),
    d1Query(
      env,
      `SELECT r.name, ri.qty, ri.unit FROM recipe_items ri
         JOIN recipes r ON r.id = ri.recipe_id
        WHERE ri.inventory_id = ? AND r.status = 'active'`,
      [id]
    ).catch(() => ({ results: [] })),
  ]);

  const item = items && items[0];
  if (!item) return json({ ok: false, error: 'Inventory item not found' }, 404);

  const byType = Object.fromEntries((moves || []).map((m) => [m.type, num(m.qty)]));
  const purchased = num(byType.purchase);
  const consumed = Math.abs(num(byType.sale));
  const wasted = Math.abs(num(byType.waste));
  const corrections = num(byType.adjustment) + num(byType.count);

  return json({
    ok: true,
    from, to,
    item: { id: item.id, name: item.name, unit: item.unit },
    purchased,
    expectedConsumption: consumed,
    wasted,
    corrections,
    currentStock: num(item.stock),
    // Positive means more had to be corrected away than sales explain.
    unexplained: round2(-corrections),
    usedBy: (recipes || []).map((r) => ({ recipe: r.name, per: num(r.qty), unit: r.unit })),
    note: 'Expected consumption is what recipes say the sales should have used. Corrections are stock counts and adjustments.',
  });
}

export async function handleReports(pathname, method, url, request, env, auth) {
  if (!pathname.startsWith('/api/reports')) return null;
  if (method.toUpperCase() !== 'GET') return null;

  const sub = pathname.replace(/^\/api\/reports/, '');

  if (sub === '/dashboard' || sub === '') return dashboard(env, url);
  if (sub === '/products') return productPerformance(env, url);
  if (sub === '/financial') return financial(env, url);
  if (sub === '/accountant') return accountantExport(env, url);

  const ing = sub.match(/^\/ingredient\/([^/]+)$/);
  if (ing) return ingredientAnswers(env, url, ing[1]);

  // GET /api/reports/staff-performance
  if (sub === '/staff-performance') {
    const { from, to } = resolveWindow(url);
    const w = [from, to];
    const { results } = await d1Query(env, `
      SELECT COALESCE(created_by, 'Unassigned') AS staff_name,
             COUNT(*) AS order_count,
             SUM(COALESCE(total,0) - COALESCE(tip,0)) AS total_sales,
             SUM(COALESCE(tip,0)) AS total_tips
        FROM orders o WHERE ${REAL_ORDERS} AND ${DATE_CLAUSE}
       GROUP BY created_by ORDER BY total_sales DESC
    `, w).catch(() => ({ results: [] }));

    const staff = (results || []).map(r => ({
      name: r.staff_name,
      ordersCount: num(r.order_count),
      totalSales: round2(r.total_sales),
      totalTips: round2(r.total_tips),
      averageOrder: num(r.order_count) ? round2(r.total_sales / r.order_count) : 0
    }));

    return json({ ok: true, period: { from, to }, staff });
  }

  // GET /api/reports/top-items
  if (sub === '/top-items') {
    const { from, to } = resolveWindow(url);
    const limit = parseInt(url.searchParams.get('limit') || '10', 10);
    const w = [from, to];
    const { results } = await d1Query(env, `
      SELECT oi.name, oi.category, SUM(oi.qty) AS quantity, SUM(oi.qty * oi.unit_price) AS total_revenue
        FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE ${REAL_ORDERS} AND oi.status <> 'cancelled' AND ${DATE_CLAUSE}
       GROUP BY oi.name, oi.category
       ORDER BY total_revenue DESC LIMIT ?
    `, [...w, limit]).catch(() => ({ results: [] }));

    return json({ ok: true, period: { from, to }, items: (results || []).map(r => ({ name: r.name, category: r.category, quantity: num(r.quantity), revenue: round2(r.total_revenue) })) });
  }

  // GET /api/reports/hourly-heatmap
  if (sub === '/hourly-heatmap') {
    const { from, to } = resolveWindow(url);
    const w = [from, to];
    const { results } = await d1Query(env, `
      SELECT strftime('%H', created) AS hour, COUNT(*) AS orders_count, ${NET_SALES} AS revenue
        FROM orders o WHERE ${REAL_ORDERS} AND ${DATE_CLAUSE}
       GROUP BY hour ORDER BY hour ASC
    `, w).catch(() => ({ results: [] }));

    const hoursMap = {};
    for (let h = 0; h < 24; h++) {
      const pad = h.toString().padStart(2, '0');
      hoursMap[pad] = { hour: pad, orders: 0, revenue: 0 };
    }
    for (const r of (results || [])) {
      if (r.hour && hoursMap[r.hour]) {
        hoursMap[r.hour].orders = num(r.orders_count);
        hoursMap[r.hour].revenue = round2(r.revenue);
      }
    }

    return json({ ok: true, period: { from, to }, hours: Object.values(hoursMap) });
  }

  return null;
}

