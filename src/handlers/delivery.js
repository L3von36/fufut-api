/**
 * Delivery lifecycle.
 *
 * Background: delivery looked implemented and was not. `orders.type` accepted
 * 'delivery', the `delivery` table existed with customer, address, driver,
 * status, eta and phone, and the POS had a Delivery screen — but nothing in the
 * API ever wrote a delivery row. A delivery order taken at the till created an
 * order and stopped there, so it never reached the Delivery screen, no driver
 * could be assigned, and the money coming back was recorded nowhere.
 *
 * Row creation now happens in orders.js, where the order is taken. This module
 * owns what happens to that job afterwards.
 *
 * ── Why the status list is explicit ─────────────────────────────────────────
 * `status` was free text with a default of 'pending', so every screen invented
 * its own vocabulary and none of them agreed. The transition table below is the
 * whole state machine, and a move that is not in it is refused rather than
 * written — the failure it prevents is an order marked delivered that was never
 * assigned to anybody.
 *
 * ── Why settlement is separate from payment ─────────────────────────────────
 * Cash in a driver's pocket is not yet the restaurant's cash. `payment_status`
 * covers the guest paying the driver; `settled_at` covers the driver handing it
 * to the cashier. Collapsing the two loses the window in which the business is
 * owed money by its own staff, which is precisely the window worth tracking.
 */

import { d1Query, d1Run, json, readBody } from '../lib/db.js';
import { writeAudit } from '../lib/audit.js';
import { actorName, isManager } from '../auth.js';

/**
 * Allowed moves. A job may also be cancelled from any state before delivery,
 * handled separately below.
 */
const TRANSITIONS = {
  new: ['confirmed', 'preparing'],
  confirmed: ['preparing'],
  preparing: ['ready'],
  // Assignment can happen while the food is still cooking, which is what
  // actually occurs on a busy evening: the driver is told what is coming next.
  ready: ['assigned'],
  assigned: ['picked_up'],
  picked_up: ['out_for_delivery', 'delivered'],
  out_for_delivery: ['delivered'],
  delivered: [],
  cancelled: [],
};

/** Kitchen progress belongs to the order; these mirror onto the job. */
const ORDER_STATUS_TO_DELIVERY = {
  new: 'new',
  preparing: 'preparing',
  ready: 'ready',
};

const TIMESTAMP_FOR = {
  assigned: 'assigned_at',
  picked_up: 'picked_up_at',
  delivered: 'delivered_at',
  cancelled: 'cancelled_at',
};

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export function canTransition(from, to) {
  if (to === 'cancelled') return from !== 'delivered' && from !== 'cancelled';
  const allowed = TRANSITIONS[String(from || 'new').toLowerCase()];
  return Array.isArray(allowed) && allowed.includes(to);
}

export { TRANSITIONS, ORDER_STATUS_TO_DELIVERY };

/**
 * The job plus the order behind it.
 *
 * The driver's screen showed an address and nothing else, because the job row
 * has no items and no total — those live on the order, and the two were never
 * joined. Without this the driver cannot tell what is in the bag or whether to
 * collect anything.
 */
async function listDeliveries(env, url) {
  const status = url.searchParams.get('status');
  const driverId = url.searchParams.get('driver_id') || url.searchParams.get('driverId');
  const clauses = [];
  const params = [];
  if (status) { clauses.push('d.status = ?'); params.push(status); }
  if (driverId) { clauses.push('d.driver_id = ?'); params.push(driverId); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const { results } = await d1Query(
    env,
    `SELECT d.*,
            o.items          AS order_items,
            o.total          AS order_total,
            o.tip            AS order_tip,
            o.status         AS order_status,
            o.payment_status AS order_payment_status,
            o.notes          AS order_notes
       FROM delivery d
       LEFT JOIN orders o ON o.id = d.orderId
       ${where}
      ORDER BY d.created DESC
      LIMIT 300`,
    params
  );
  return json(results || []);
}

/**
 * Move a job along.
 *
 * `driverId` is required to assign, because "assigned" with nobody named is the
 * state the old free-text column allowed and it tells nobody anything.
 */
async function advance(request, env, auth, id) {
  const data = (await readBody(request)) || {};
  const to = String(data.status || '').toLowerCase().replace(/[\s-]+/g, '_');
  if (!to) return json({ ok: false, error: 'status required' }, 400);

  const { results } = await d1Query(env, 'SELECT * FROM delivery WHERE id = ?', [id]);
  const job = results && results[0];
  if (!job) return json({ ok: false, error: 'Delivery not found' }, 404);

  const from = String(job.status || 'new').toLowerCase();
  if (from === to) return json({ ok: true, status: to, unchanged: true });

  if (!canTransition(from, to)) {
    return json(
      {
        ok: false,
        error: `A delivery cannot go from "${from}" to "${to}"`,
        allowed: to === 'cancelled' ? [] : TRANSITIONS[from] || [],
      },
      409
    );
  }

  if (to === 'cancelled' && !data.reason) {
    return json({ ok: false, error: 'A reason is required to cancel a delivery' }, 400);
  }

  const fields = ['status = ?', 'updated_at = ?'];
  const nowIso = new Date().toISOString();
  const values = [to, nowIso];

  if (to === 'assigned') {
    const driverId = data.driverId || data.driver_id;
    if (!driverId) {
      return json({ ok: false, error: 'driverId is required to assign a delivery' }, 400);
    }
    const { results: staff } = await d1Query(
      env,
      "SELECT id, firstName, lastName, role FROM staff WHERE id = ? AND status = 'active'",
      [String(driverId)]
    );
    const driver = staff && staff[0];
    if (!driver) return json({ ok: false, error: 'Driver not found or inactive' }, 404);
    fields.push('driver_id = ?', 'driver = ?');
    values.push(driver.id, [driver.firstName, driver.lastName].filter(Boolean).join(' '));
  }

  const stamp = TIMESTAMP_FOR[to];
  if (stamp) {
    // COALESCE so re-tapping a stage cannot rewind the recorded time — the same
    // rule the kitchen's per-item timing already follows.
    fields.push(`${stamp} = COALESCE(${stamp}, ?)`);
    values.push(nowIso);
  }
  if (data.eta) { fields.push('eta = ?'); values.push(String(data.eta)); }
  if (data.notes) { fields.push('notes = ?'); values.push(String(data.notes).trim()); }

  values.push(id);
  await d1Run(env, `UPDATE delivery SET ${fields.join(', ')} WHERE id = ?`, values);

  // A delivered job closes its order, but only once the money is in. An unpaid
  // delivery stays open so it appears on the cashier's outstanding list rather
  // than disappearing into the completed pile.
  if (to === 'delivered' && job.orderId) {
    const { results: ord } = await d1Query(env, 'SELECT payment_status FROM orders WHERE id = ?', [job.orderId]);
    const paid = ord && ord[0] && ord[0].payment_status === 'paid';
    await d1Run(
      env,
      'UPDATE orders SET status = ?, served_at = COALESCE(served_at, ?), updated_at = ? WHERE id = ?',
      [paid ? 'completed' : 'served', nowIso, nowIso, job.orderId]
    );
  }
  if (to === 'cancelled' && job.orderId) {
    await d1Run(
      env,
      'UPDATE orders SET status = ?, void_reason = ?, voided_at = COALESCE(voided_at, ?), updated_at = ? WHERE id = ?',
      ['cancelled', String(data.reason).trim(), nowIso, nowIso, job.orderId]
    );
  }

  await writeAudit(env, auth, {
    action: to === 'cancelled' ? 'void' : 'update',
    entity: 'delivery',
    entityId: id,
    before: { status: from },
    after: { status: to, driver_id: data.driverId || job.driver_id || null },
    reason: data.reason || null,
  });

  return json({ ok: true, status: to });
}

/**
 * The driver hands the round's takings to the cashier.
 *
 * Only a cashier or manager can close this: the point of the step is that
 * somebody other than the person carrying the money agrees it arrived. A driver
 * marking their own round settled would make the control meaningless.
 */
async function settle(request, env, auth, id) {
  const role = String((auth && (auth.sessionRole || auth.role)) || '').toLowerCase();
  if (role !== 'cashier' && !isManager(role)) {
    return json({ ok: false, error: 'Only a cashier or manager can settle a delivery' }, 403);
  }

  const { results } = await d1Query(env, 'SELECT * FROM delivery WHERE id = ?', [id]);
  const job = results && results[0];
  if (!job) return json({ ok: false, error: 'Delivery not found' }, 404);
  if (job.settled_at) return json({ ok: false, error: 'Already settled' }, 409);

  // Settlement asserts the money is in the till, so the order must actually
  // show payment against it. Otherwise this becomes a way to close a round with
  // nothing collected.
  const { results: pays } = await d1Query(
    env,
    "SELECT amount FROM payments WHERE order_id = ? AND status <> 'rejected'",
    [job.orderId]
  );
  const taken = round2((pays || []).reduce((s, p) => s + (Number(p.amount) || 0), 0));
  if (taken <= 0) {
    return json(
      { ok: false, error: 'No payment has been recorded against this delivery yet' },
      409
    );
  }

  const nowIso = new Date().toISOString();
  await d1Run(
    env,
    `UPDATE delivery SET payment_status = 'settled', settled_at = ?, settled_by = ?, updated_at = ? WHERE id = ?`,
    [nowIso, auth ? actorName(auth) : null, nowIso, id]
  );
  if (job.orderId) {
    await d1Run(env, "UPDATE orders SET status = 'completed', updated_at = ? WHERE id = ?", [nowIso, job.orderId]);
  }

  await writeAudit(env, auth, {
    action: 'verify',
    entity: 'delivery',
    entityId: id,
    before: { payment_status: job.payment_status },
    after: { payment_status: 'settled', collected: taken },
  });

  return json({ ok: true, settled: true, collected: taken });
}

/**
 * Mirror kitchen progress onto the delivery job.
 *
 * Called from the order status path so the chef marking food ready is what puts
 * the job in front of a driver, rather than somebody having to remember to move
 * it by hand on a second screen.
 */
export async function syncDeliveryToOrderStatus(env, orderId, orderStatus) {
  const mapped = ORDER_STATUS_TO_DELIVERY[String(orderStatus || '').toLowerCase()];
  if (!mapped) return;
  try {
    const { results } = await d1Query(env, 'SELECT id, status FROM delivery WHERE orderId = ?', [orderId]);
    const job = results && results[0];
    if (!job) return;
    // Never drag a job backwards: once a driver has it, the kitchen's opinion
    // of the order is no longer what determines where the food is.
    if (!canTransition(String(job.status || 'new').toLowerCase(), mapped)) return;
    await d1Run(env, 'UPDATE delivery SET status = ?, updated_at = ? WHERE id = ?', [
      mapped,
      new Date().toISOString(),
      job.id,
    ]);
  } catch (e) {
    // A delivery board that lags is recoverable; a kitchen that cannot mark
    // food ready is not.
    console.error('[DELIVERY SYNC]', e);
  }
}

export async function handleDelivery(pathname, method, url, request, env, auth) {
  if (!pathname.startsWith('/api/delivery')) return null;
  const m = method.toUpperCase();
  const sub = pathname.replace(/^\/api\/delivery/, '');

  if (m === 'GET' && sub === '') return listDeliveries(env, url);

  const status = sub.match(/^\/([^/]+)\/status$/);
  if (m === 'POST' && status) return advance(request, env, auth, status[1]);

  const settleMatch = sub.match(/^\/([^/]+)\/settle$/);
  if (m === 'POST' && settleMatch) return settle(request, env, auth, settleMatch[1]);

  // Anything else — plain PUT edits to address, phone, eta and notes — falls
  // through to the generic resource handler, which already does that correctly.
  return null;
}
