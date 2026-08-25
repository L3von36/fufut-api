/**
 * Payments and tips.
 *
 * Background: `orders.payment` was a single TEXT column. A split bill was stored
 * as the string "cash+telebirr" — the methods survived, the amounts did not.
 * There was nowhere to put a transfer reference, a payment screenshot, or the
 * cashier's verification, so none of §9's requirements could be met and
 * per-method revenue could not be reported.
 *
 * `orders.payment` is still written, because the receipt and several screens
 * read it. It is now a summary of this table rather than the record itself.
 *
 * ── Two invariants ──────────────────────────────────────────────────────────
 *
 * 1. **Money is never removed by deleting a row.** `amount` is signed, so a
 *    refund is a negative payment against the same order. The balance is always
 *    SUM(amount), and the history of how it got there survives.
 *
 * 2. **A tip is not revenue.** Tips live in their own table, never in
 *    `payments`. Sharing a table with the takings and relying on every future
 *    query to remember an exclusion is the fastest way to overstate a day.
 *    Note that `orders.total` *does* include the tip, because it is what the
 *    guest hands over; net sales is therefore `total - tip`, and
 *    `orderFinancials()` below is the one place that subtraction is expressed.
 */

import { d1Query, d1Run, json, readBody } from '../lib/db.js';
import { writeAudit } from '../lib/audit.js';
import { actorName, isManager } from '../auth.js';
import { addToOpenDrawerCash } from '../lib/drawer.js';

/** Methods the business accepts. Anything else is refused rather than stored. */
const METHODS = new Set(['cash', 'telebirr', 'cbe', 'bank', 'card', 'mobile', 'other']);

/**
 * Digital transfers are only worth recording if they can be checked later, so
 * these require a cashier or manager to verify before the money is treated as
 * settled. Cash is confirmed by being in the drawer.
 */
const NEEDS_VERIFICATION = new Set(['telebirr', 'cbe', 'bank']);

/** Half a birr, the same tolerance the POS split-bill validator already uses. */
const EPSILON = 0.5;

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * What is owed and what has been taken on one order.
 *
 * `total` includes the tip because that is what the guest pays. `netSales` is
 * the restaurant's share and is what every revenue report must use.
 */
export function orderFinancials(order, payments) {
  const total = round2(order.total);
  const tip = round2(order.tip);
  const paid = round2((payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0));
  return {
    total,
    tip,
    netSales: round2(total - tip),
    paid,
    outstanding: round2(total - paid),
    settled: Math.abs(total - paid) < EPSILON,
  };
}

/**
 * Recompute and store an order's payment status from its payment rows.
 *
 * Derived rather than set, so it cannot drift from the payments that justify
 * it — the failure mode this replaces is an order marked paid with no payment
 * behind it, which is exactly what §43 warns about.
 */
export async function refreshPaymentStatus(env, orderId) {
  const { results: orders } = await d1Query(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
  const order = orders && orders[0];
  if (!order) return null;

  const { results: pays } = await d1Query(
    env,
    "SELECT * FROM payments WHERE order_id = ? AND status <> 'rejected'",
    [orderId]
  );
  const fin = orderFinancials(order, pays || []);

  let status = 'unpaid';
  if (fin.paid > 0 && !fin.settled) status = fin.outstanding > 0 ? 'partial' : 'overpaid';
  else if (fin.settled && fin.paid > 0) status = 'paid';

  // paid_at marks the moment the bill was first settled in full and is never
  // rewritten, so a later refund does not erase when the guest actually paid.
  const paidAt = status === 'paid' ? (order.paid_at || new Date().toISOString()) : order.paid_at;

  await d1Run(env, 'UPDATE orders SET payment_status = ?, paid_at = ? WHERE id = ?', [
    status,
    paidAt || null,
    orderId,
  ]);

  return { ...fin, status };
}

/**
 * Record one tender against an order.
 *
 * Guards, each of which corresponds to a failure listed in §56 of the spec:
 *   - payment without an order        → 404
 *   - unknown method                  → 400
 *   - zero amount                      → 400
 *   - payment greater than the total   → 400 unless explicitly allowed
 *   - payment against a voided order   → 409
 */
async function recordPayment(request, env, auth) {
  const data = await readBody(request);
  if (!data) return json({ ok: false, error: 'Invalid JSON body' }, 400);

  const orderId = String(data.orderId || data.order_id || '').trim();
  if (!orderId) return json({ ok: false, error: 'orderId required' }, 400);

  const { results } = await d1Query(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
  const order = results && results[0];
  if (!order) return json({ ok: false, error: 'Order not found' }, 404);
  if (order.voided_at) return json({ ok: false, error: 'Order has been voided' }, 409);

  const method = String(data.method || '').toLowerCase();
  if (!METHODS.has(method)) {
    return json({ ok: false, error: `Unknown payment method "${data.method}"` }, 400);
  }

  const amount = round2(data.amount);
  if (!amount) return json({ ok: false, error: 'amount must be non-zero' }, 400);

  // Overpayment is refused rather than silently accepted. A cash guest handing
  // over more than the bill is change, not a larger payment — `tendered` and
  // `change_due` carry that, and `amount` stays the sum actually kept.
  if (amount > 0) {
    const { results: existing } = await d1Query(
      env,
      "SELECT amount FROM payments WHERE order_id = ? AND status <> 'rejected'",
      [orderId]
    );
    const already = round2((existing || []).reduce((s, p) => s + (Number(p.amount) || 0), 0));
    const outstanding = round2(round2(order.total) - already);
    if (amount - outstanding > EPSILON && !data.allowOverpayment) {
      return json(
        {
          ok: false,
          error: `Payment of ${amount} exceeds the ${outstanding} outstanding on this order`,
          outstanding,
        },
        400
      );
    }
  }

  const nowIso = new Date().toISOString();
  const id = 'PM' + crypto.randomUUID().slice(0, 10);
  // A transfer starts unverified; cash is settled by being in the drawer.
  const status = NEEDS_VERIFICATION.has(method) ? 'recorded' : 'verified';

  await d1Run(
    env,
    `INSERT INTO payments
       (id, order_id, method, amount, tendered, change_due, reference, evidence_key,
        status, collected_by, collected_by_name, verified_by, verified_by_name,
        verified_at, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      orderId,
      method,
      amount,
      data.tendered !== undefined ? round2(data.tendered) : null,
      data.changeDue !== undefined ? round2(data.changeDue) : null,
      data.reference ? String(data.reference).trim() : null,
      data.evidenceKey ? String(data.evidenceKey) : null,
      status,
      (auth && auth.staff_id) || null,
      auth ? actorName(auth) : null,
      status === 'verified' ? (auth && auth.staff_id) || null : null,
      status === 'verified' ? (auth ? actorName(auth) : null) : null,
      status === 'verified' ? nowIso : null,
      data.notes ? String(data.notes).trim() : null,
      nowIso,
    ]
  );

  const fin = await refreshPaymentStatus(env, orderId);
  await writeAudit(env, auth, {
    action: 'create',
    entity: 'payments',
    entityId: id,
    after: { order_id: orderId, method, amount, reference: data.reference || null, status },
  });

  // A cash payment made directly against an order (a driver collecting on the
  // doorstep, a cashier taking a part-payment) lands in the same open till.
  if (method === 'cash' && amount > 0) await addToOpenDrawerCash(env, amount);

  return json({
    ok: true,
    id,
    status,
    requiresVerification: status === 'recorded',
    order: fin,
  });
}

/**
 * A cashier confirming a transfer actually arrived.
 *
 * Deliberately not available to the person who recorded it when that person is
 * the driver: the point of the step is that a second pair of eyes sees the
 * evidence. Enforced by role — delivery staff cannot reach this endpoint at all.
 */
async function verifyPayment(request, env, auth, paymentId) {
  const data = (await readBody(request)) || {};
  const { results } = await d1Query(env, 'SELECT * FROM payments WHERE id = ?', [paymentId]);
  const payment = results && results[0];
  if (!payment) return json({ ok: false, error: 'Payment not found' }, 404);

  const reject = data.reject === true;
  const status = reject ? 'rejected' : 'verified';
  const nowIso = new Date().toISOString();

  if (reject && !data.reason) {
    return json({ ok: false, error: 'A reason is required to reject a payment' }, 400);
  }

  await d1Run(
    env,
    `UPDATE payments
        SET status = ?, verified_by = ?, verified_by_name = ?, verified_at = ?, notes = COALESCE(?, notes)
      WHERE id = ?`,
    [
      status,
      (auth && auth.staff_id) || null,
      auth ? actorName(auth) : null,
      nowIso,
      data.reason ? String(data.reason).trim() : null,
      paymentId,
    ]
  );

  const fin = await refreshPaymentStatus(env, payment.order_id);
  await writeAudit(env, auth, {
    action: 'verify',
    entity: 'payments',
    entityId: paymentId,
    before: { status: payment.status },
    after: { status },
    reason: data.reason || null,
  });

  return json({ ok: true, status, order: fin });
}

/**
 * Refund as a negative payment against the same order.
 *
 * The original row is left exactly as it was. Reversing by editing the payment
 * that was taken would destroy the fact that money changed hands twice, which
 * is the thing a refund most needs to prove.
 */
async function refundPayment(request, env, auth, paymentId) {
  const data = (await readBody(request)) || {};
  if (!data.reason) return json({ ok: false, error: 'A reason is required to refund' }, 400);

  const { results } = await d1Query(env, 'SELECT * FROM payments WHERE id = ?', [paymentId]);
  const original = results && results[0];
  if (!original) return json({ ok: false, error: 'Payment not found' }, 404);
  if (Number(original.amount) < 0) {
    return json({ ok: false, error: 'That row is already a refund' }, 400);
  }

  // A partial refund is allowed; more than was taken is not.
  const requested = data.amount !== undefined ? round2(data.amount) : round2(original.amount);
  if (requested <= 0) return json({ ok: false, error: 'Refund amount must be positive' }, 400);
  if (requested - round2(original.amount) > EPSILON) {
    return json(
      { ok: false, error: `Cannot refund ${requested}; only ${round2(original.amount)} was taken` },
      400
    );
  }

  const nowIso = new Date().toISOString();
  const id = 'PM' + crypto.randomUUID().slice(0, 10);
  await d1Run(
    env,
    `INSERT INTO payments
       (id, order_id, method, amount, reference, status, collected_by, collected_by_name,
        verified_by, verified_by_name, verified_at, notes, created_at)
     VALUES (?, ?, ?, ?, ?, 'verified', ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      original.order_id,
      original.method,
      -requested,
      original.reference || null,
      (auth && auth.staff_id) || null,
      auth ? actorName(auth) : null,
      (auth && auth.staff_id) || null,
      auth ? actorName(auth) : null,
      nowIso,
      `Refund of ${paymentId}: ${String(data.reason).trim()}`,
      nowIso,
    ]
  );

  await d1Run(env, "UPDATE payments SET status = 'refunded' WHERE id = ?", [paymentId]);

  // Cash handed back leaves the till it went into, so an open drawer's tally
  // comes down by the same figure. A refund after the drawer closed leaves no
  // drawer to adjust — the Z-report stands as counted.
  if (String(original.method || '').toLowerCase() === 'cash') {
    await addToOpenDrawerCash(env, -requested);
  }

  const fin = await refreshPaymentStatus(env, original.order_id);
  await writeAudit(env, auth, {
    action: 'refund',
    entity: 'payments',
    entityId: paymentId,
    before: { amount: original.amount, status: original.status },
    after: { refund_id: id, amount: -requested, status: 'refunded' },
    reason: String(data.reason).trim(),
  });

  return json({ ok: true, id, refunded: requested, order: fin });
}

/** Revenue by payment method over a range. Excludes rejected rows. */
async function paymentSummary(env, url) {
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const clauses = ["status <> 'rejected'"];
  const params = [];
  if (from) { clauses.push('created_at >= ?'); params.push(from); }
  if (to) { clauses.push('created_at <= ?'); params.push(to); }

  const { results } = await d1Query(
    env,
    `SELECT method,
            COUNT(*)    AS count,
            SUM(amount) AS total
       FROM payments
      WHERE ${clauses.join(' AND ')}
      GROUP BY method
      ORDER BY total DESC`,
    params
  );

  const methods = (results || []).map((r) => ({
    method: r.method,
    count: r.count,
    total: round2(r.total),
  }));
  return json({
    ok: true,
    from,
    to,
    methods,
    total: round2(methods.reduce((s, m) => s + m.total, 0)),
  });
}

// ── Tips ────────────────────────────────────────────────────────────────────

/**
 * Record a tip against a member of staff.
 *
 * `staffId` defaults to whoever is signed in, which is right for a waiter
 * closing their own table, but a cashier settling a driver's round needs to
 * name the driver, so it stays overridable.
 */
async function recordTip(request, env, auth) {
  const data = await readBody(request);
  if (!data) return json({ ok: false, error: 'Invalid JSON body' }, 400);

  const amount = round2(data.amount);
  if (amount <= 0) return json({ ok: false, error: 'Tip amount must be positive' }, 400);

  const staffId = data.staffId || data.staff_id || (auth && auth.staff_id) || null;
  let staffName = data.staffName || null;
  if (!staffName && staffId) {
    const { results } = await d1Query(env, 'SELECT firstName, lastName FROM staff WHERE id = ?', [
      String(staffId),
    ]);
    const s = results && results[0];
    if (s) staffName = [s.firstName, s.lastName].filter(Boolean).join(' ');
  }

  const nowIso = new Date().toISOString();
  const id = 'TP' + crypto.randomUUID().slice(0, 10);
  await d1Run(
    env,
    `INSERT INTO tips
       (id, order_id, staff_id, staff_name, amount, method, evidence_key, status, source, date, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'recorded', ?, ?, ?, ?)`,
    [
      id,
      data.orderId || data.order_id || null,
      staffId,
      staffName,
      amount,
      data.method ? String(data.method).toLowerCase() : null,
      data.evidenceKey || null,
      data.source || null,
      data.date || today(),
      data.notes ? String(data.notes).trim() : null,
      nowIso,
    ]
  );

  await writeAudit(env, auth, {
    action: 'create',
    entity: 'tips',
    entityId: id,
    after: { order_id: data.orderId || null, staff_id: staffId, amount },
  });

  return json({ ok: true, id });
}

/**
 * Tips grouped by member of staff, plus a daily series.
 *
 * The manager's question is "what does each person take home", so staff leads.
 * `byDate` is what the daily/weekly/monthly toggles on the dashboard read.
 */
async function tipSummary(env, url) {
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const clauses = ["status <> 'rejected'"];
  const params = [];
  if (from) { clauses.push('date >= ?'); params.push(from); }
  if (to) { clauses.push('date <= ?'); params.push(to); }
  const where = clauses.join(' AND ');

  const [byStaff, byDate] = await Promise.all([
    d1Query(
      env,
      `SELECT staff_id, staff_name, COUNT(*) AS count, SUM(amount) AS total
         FROM tips WHERE ${where}
        GROUP BY staff_id, staff_name ORDER BY total DESC`,
      params
    ),
    d1Query(
      env,
      `SELECT date, SUM(amount) AS total FROM tips WHERE ${where}
        GROUP BY date ORDER BY date`,
      params
    ),
  ]);

  const staff = (byStaff.results || []).map((r) => ({
    staffId: r.staff_id,
    staffName: r.staff_name,
    count: r.count,
    total: round2(r.total),
  }));

  return json({
    ok: true,
    from,
    to,
    byStaff: staff,
    byDate: (byDate.results || []).map((r) => ({ date: r.date, total: round2(r.total) })),
    total: round2(staff.reduce((s, r) => s + r.total, 0)),
  });
}

// ── Router ──────────────────────────────────────────────────────────────────

export async function handlePayments(pathname, method, url, request, env, auth) {
  const m = method.toUpperCase();

  if (pathname.startsWith('/api/payments')) {
    const sub = pathname.replace(/^\/api\/payments/, '');

    if (m === 'GET' && sub === '/summary') return paymentSummary(env, url);

    if (m === 'GET' && sub === '') {
      const orderId = url.searchParams.get('order_id') || url.searchParams.get('orderId');
      if (orderId) {
        const { results } = await d1Query(
          env,
          'SELECT * FROM payments WHERE order_id = ? ORDER BY created_at',
          [orderId]
        );
        return json(results || []);
      }
      const { results } = await d1Query(
        env,
        'SELECT * FROM payments ORDER BY created_at DESC LIMIT 500'
      );
      return json(results || []);
    }

    if (m === 'POST' && sub === '') return recordPayment(request, env, auth);

    const verify = sub.match(/^\/([^/]+)\/verify$/);
    if (m === 'POST' && verify) {
      // Verification is the control that makes a transfer trustworthy, so it
      // belongs with the people who answer for the till, not with whoever
      // recorded the payment.
      const role = String((auth && (auth.sessionRole || auth.role)) || '').toLowerCase();
      if (role !== 'cashier' && !isManager(role)) {
        return json({ ok: false, error: 'Only a cashier or manager can verify a payment' }, 403);
      }
      return verifyPayment(request, env, auth, verify[1]);
    }

    const refund = sub.match(/^\/([^/]+)\/refund$/);
    if (m === 'POST' && refund) {
      if (!isManager((auth && (auth.sessionRole || auth.role)) || '')) {
        return json({ ok: false, error: 'Only a manager can refund a payment' }, 403);
      }
      return refundPayment(request, env, auth, refund[1]);
    }

    // Payments are never deleted. Reversal is a refund; a mistake is a rejection.
    if (m === 'DELETE') {
      return json(
        { ok: false, error: 'Payments cannot be deleted. Refund or reject it instead.' },
        405
      );
    }
  }

  if (pathname.startsWith('/api/tips')) {
    const sub = pathname.replace(/^\/api\/tips/, '');

    if (m === 'GET' && sub === '/summary') return tipSummary(env, url);

    if (m === 'GET' && sub === '') {
      const clauses = [];
      const params = [];
      const staffId = url.searchParams.get('staff_id') || url.searchParams.get('staffId');
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      if (staffId) { clauses.push('staff_id = ?'); params.push(staffId); }
      if (from) { clauses.push('date >= ?'); params.push(from); }
      if (to) { clauses.push('date <= ?'); params.push(to); }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const { results } = await d1Query(
        env,
        `SELECT * FROM tips ${where} ORDER BY date DESC, created_at DESC LIMIT 500`,
        params
      );
      return json(results || []);
    }

    if (m === 'POST' && sub === '') return recordTip(request, env, auth);
  }

  return null;
}
