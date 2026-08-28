/**
 * Operations rules — how long is too long.
 *
 * A restaurant is a clock business. Every stage of an order has a natural
 * lifetime, and past it somebody is standing there with food they did not
 * order: a guest waiting an hour for a burger, a driver's bag going cold on
 * the pass, a bill nobody brought. None of this is exotic — it is "compare a
 * stamp against a threshold" — but until now nothing in the system asked the
 * question, so the only alarm was a human noticing.
 *
 * Everything here is pure: rows in, violations out, no database and no clock
 * but the one handed in. That is the same discipline staleness.js and
 * booking.js follow, for the same reason — thresholds this business-facing
 * will be argued about, and the argument should be testable without standing
 * up D1.
 *
 * Clocks, precisely. The orders table already stamps the moment a ticket
 * entered each state (`preparing_at`, `ready_at`, `served_at`), so a rule
 * about "how long in preparing" reads that column rather than guessing from
 * `created`. Falling back through `updated_at` to `created` covers rows
 * written before a column existed or by a path that forgot to stamp.
 */

import { isLapsedNoShow } from './booking.js';

/** Severity words, one place. */
export const SEVERITY = { WARNING: 'warning', CRITICAL: 'critical' };

/**
 * The rules, by stable id. These strings are stored in `alerts.rule_id` and
 * referenced by tests and screens; renaming one orphans every open alert.
 */
export const RULE_IDS = {
  PREPARING_TOO_LONG: 'order-preparing-too-long',
  NEW_UNACCEPTED: 'order-new-unaccepted',
  READY_NOT_SERVED: 'order-ready-not-served',
  DELIVERY_UNASSIGNED: 'delivery-ready-unassigned',
  DELIVERY_IN_TRANSIT: 'delivery-in-transit-too-long',
  SERVED_UNPAID: 'order-served-unpaid',
  RESERVATION_NO_SHOW: 'reservation-no-show',
  TABLE_SEATED_TOO_LONG: 'table-seated-too-long',
};

/**
 * Threshold defaults, in minutes.
 *
 * Twenty minutes to a warning is the kitchen's own sense of a rush gone
 * wrong — the ticket is late but survivable — and forty is the point past
 * which the food or the guest is lost. The others are single-stage: the
 * breach itself is the whole story. Every number is overridable from the
 * settings table (see loadAlertThresholds in handlers/alerts.js), because a
 * cafe at noon and a restaurant at eight do not want the same numbers and
 * the person who knows is not the one deploying.
 */
export const RULE_DEFAULTS = {
  preparingWarnMin: 20,
  preparingCriticalMin: 40,
  newUnacceptedMin: 5,
  readyUnservedMin: 10,
  deliveryUnassignedMin: 10,
  deliveryTransitMaxMin: 45,
  servedUnpaidMin: 30,
  reservationNoShowMin: 15,
  tableSeatedMaxMin: 90,
};

/** Minutes since an ISO-ish stamp, or null when the stamp cannot be read. */
export function ageMinutes(stamp, nowMs) {
  const t = Date.parse(String(stamp || '').trim());
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (nowMs - t) / 60000);
}

/** "18 min", "1 h 05 min" — one spelling everywhere a rule speaks. */
export function fmtMin(min) {
  if (!Number.isFinite(min)) return '?';
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/**
 * The human name of what an order is for.
 *
 * The kitchen thinks in tables, the website in "QR order", the counter in
 * "takeaway". The label leads the message so a busy screen answers "whose
 * food?" before "what about it?".
 */
export function orderLabel(order) {
  if (!order) return 'Order';
  const table = String(order.table_id || order.table_number || '').trim();
  if (table) return `Table ${table}`;
  const type = String(order.type || '').toLowerCase();
  if (type.includes('deliver')) return 'Delivery order';
  if (type.includes('take') || type.includes('pickup')) return 'Takeaway order';
  if (String(order.source || '').toLowerCase() === 'qr') return 'QR order';
  return 'Order';
}

/** First readable stamp of the chain, or null. */
function firstStamp(nowMs, ...stamps) {
  for (const s of stamps) {
    const age = ageMinutes(s, nowMs);
    if (age !== null) return age;
  }
  return null;
}

function violation(ruleId, severity, entityType, entityId, label, message) {
  return {
    rule_id: ruleId,
    severity,
    entity_type: entityType,
    entity_id: String(entityId),
    entity_label: label,
    message,
  };
}

const UNPAID = new Set(['unpaid', 'partial', '']);

/**
 * Does one order break a stage rule?
 *
 * An order has exactly one status, so it can break at most one stage rule —
 * the switch is on status and falls straight through otherwise. Delivery
 * orders are skipped here on purpose: their job rows carry the driver state,
 * and the delivery rules below answer those questions against the right
 * clock. A served-but-unpaid dine-in ticket is still checked; that rule is
 * about money on the floor, not food.
 */
export function evaluateOrder(order, nowMs, th = RULE_DEFAULTS) {
  if (!order || !order.id) return null;
  const status = String(order.status || '').toLowerCase();
  const type = String(order.type || '').toLowerCase();
  const isDelivery = type.includes('deliver');

  if (status === 'new') {
    const age = firstStamp(nowMs, order.created, order.updated_at);
    if (age !== null && age > th.newUnacceptedMin) {
      return violation(
        RULE_IDS.NEW_UNACCEPTED, SEVERITY.WARNING, 'order', order.id,
        orderLabel(order),
        `${orderLabel(order)} waiting ${fmtMin(age)} — nobody has accepted it (limit ${th.newUnacceptedMin} min)`
      );
    }
    return null;
  }

  if (status === 'preparing') {
    const age = firstStamp(nowMs, order.preparing_at, order.updated_at, order.created);
    if (age !== null && age > th.preparingWarnMin) {
      const severity = age > th.preparingCriticalMin ? SEVERITY.CRITICAL : SEVERITY.WARNING;
      return violation(
        RULE_IDS.PREPARING_TOO_LONG, severity, 'order', order.id,
        orderLabel(order),
        `${orderLabel(order)} in preparing for ${fmtMin(age)} (limit ${th.preparingWarnMin} min${severity === SEVERITY.CRITICAL ? `, critical at ${th.preparingCriticalMin}` : ''})`
      );
    }
    return null;
  }

  if (status === 'ready' && !isDelivery) {
    const age = firstStamp(nowMs, order.ready_at, order.updated_at, order.created);
    if (age !== null && age > th.readyUnservedMin) {
      return violation(
        RULE_IDS.READY_NOT_SERVED, SEVERITY.WARNING, 'order', order.id,
        orderLabel(order),
        `${orderLabel(order)} — food ready ${fmtMin(age)}, not served (limit ${th.readyUnservedMin} min)`
      );
    }
    return null;
  }

  if ((status === 'served' || status === 'fulfilled') && UNPAID.has(String(order.payment_status || '').toLowerCase())) {
    const age = firstStamp(nowMs, order.served_at, order.updated_at, order.created);
    if (age !== null && age > th.servedUnpaidMin) {
      return violation(
        RULE_IDS.SERVED_UNPAID, SEVERITY.WARNING, 'order', order.id,
        orderLabel(order),
        `${orderLabel(order)} — served ${fmtMin(age)} ago, bill still open (limit ${th.servedUnpaidMin} min)`
      );
    }
    return null;
  }

  return null;
}

/** Every order violation in one pass. */
export function evaluateOrders(orders, nowMs, th = RULE_DEFAULTS) {
  const out = [];
  for (const o of orders || []) {
    const v = evaluateOrder(o, nowMs, th);
    if (v) out.push(v);
  }
  return out;
}

/**
 * Does one delivery job break a rule?
 *
 * Two questions, both about the driver: is food sitting ready with nobody to
 * take it, and is a driver out too long. The job's status mirrors the order's
 * through the state machine in handlers/delivery.js, so `ready` on a job is
 * "food on the pass, waiting for a rider" — assignment can legitimately
 * happen earlier, while the food is still cooking.
 */
export function evaluateDeliveryJob(job, nowMs, th = RULE_DEFAULTS) {
  if (!job || !job.id) return null;
  const status = String(job.status || '').toLowerCase();
  const label = `Delivery to ${String(job.customer || '').trim() || 'customer'}`;

  if (status === 'ready' && !(String(job.driver_id || '').trim())) {
    const age = firstStamp(nowMs, job.updated_at, job.created);
    if (age !== null && age > th.deliveryUnassignedMin) {
      return violation(
        RULE_IDS.DELIVERY_UNASSIGNED, SEVERITY.WARNING, 'delivery', job.id,
        label,
        `${label} — food ready ${fmtMin(age)}, no driver assigned (limit ${th.deliveryUnassignedMin} min)`
      );
    }
    return null;
  }

  if (status === 'picked_up' || status === 'out_for_delivery') {
    const stamp = status === 'picked_up'
      ? (job.picked_up_at || job.updated_at)
      : (job.updated_at || job.picked_up_at);
    const age = firstStamp(nowMs, stamp);
    if (age !== null && age > th.deliveryTransitMaxMin) {
      return violation(
        RULE_IDS.DELIVERY_IN_TRANSIT, SEVERITY.WARNING, 'delivery', job.id,
        label,
        `${label} — ${status === 'picked_up' ? 'picked up' : 'out for delivery'} ${fmtMin(age)}, still not delivered (limit ${th.deliveryTransitMaxMin} min)`
      );
    }
    return null;
  }

  return null;
}

/** Every delivery violation in one pass. */
export function evaluateDeliveryJobs(jobs, nowMs, th = RULE_DEFAULTS) {
  const out = [];
  for (const j of jobs || []) {
    const v = evaluateDeliveryJob(j, nowMs, th);
    if (v) out.push(v);
  }
  return out;
}

/**
 * Has this reservation silently died?
 *
 * The booking module already knows what a lapsed booking looks like — active
 * status, no no-show mark, grace period blown. That judgement is reused, not
 * restated; the rule adds only the message and the threshold, so a manager
 * who wants a stricter grace period gets it everywhere at once.
 */
export function evaluateReservation(reservation, nowMs, th = RULE_DEFAULTS) {
  if (!reservation || !reservation.id) return null;
  const grace = Number.isFinite(th.reservationNoShowMin) ? th.reservationNoShowMin : RULE_DEFAULTS.reservationNoShowMin;
  if (!isLapsedNoShow(reservation, nowMs, grace)) return null;

  const when = [reservation.date, reservation.time].filter(Boolean).join(' ');
  const guests = Number(reservation.guests) || 0;
  const who = String(reservation.name || '').trim() || 'A guest';
  return violation(
    RULE_IDS.RESERVATION_NO_SHOW, SEVERITY.WARNING, 'reservation', reservation.id,
    `Reservation — ${who}`,
    `Reservation: ${who}${guests ? `, ${guests} guests` : ''}${when ? ` for ${when}` : ''} — ${grace} min past time, not seated`
  );
}

/** Every no-show violation in one pass. */
export function evaluateReservations(reservations, nowMs, th = RULE_DEFAULTS) {
  const out = [];
  for (const r of reservations || []) {
    const v = evaluateReservation(r, nowMs, th);
    if (v) out.push(v);
  }
  return out;
}

/**
 * Has this table been held past a normal sitting?
 *
 * Deliberately earlier than the four-hour auto-release in staleness.js,
 * which is the "nobody ever cleared this" backstop. At ninety minutes the
 * guests are probably still there — the point of the alert is turnover: a
 * table that could be turning is not. Same shape as the auto-release rule,
 * so a venue that seats long dinners raises the threshold and keeps only
 * the backstop.
 */
export function evaluateTable(table, nowMs, th = RULE_DEFAULTS) {
  if (!table || !table.id) return null;
  if (String(table.status || '').toLowerCase() !== 'occupied') return null;
  const age = ageMinutes(table.seated_at, nowMs);
  if (age === null || age <= th.tableSeatedMaxMin) return null;

  const guests = Number(table.guests) || 0;
  const name = String(table.name || '').trim();
  const label = name ? `Table ${name}` : `Table ${table.id}`;
  return violation(
    RULE_IDS.TABLE_SEATED_TOO_LONG, SEVERITY.WARNING, 'table', table.id,
    label,
    `${label} — guests seated ${fmtMin(age)} ago${guests ? ` (${guests} guests)` : ''} (limit ${th.tableSeatedMaxMin} min)`
  );
}

/** Every table violation in one pass. */
export function evaluateTables(tables, nowMs, th = RULE_DEFAULTS) {
  const out = [];
  for (const t of tables || []) {
    const v = evaluateTable(t, nowMs, th);
    if (v) out.push(v);
  }
  return out;
}

/**
 * One sweep over everything.
 *
 * Takes the four collections already loaded by the caller and returns every
 * live violation. The dedupe key — rule, entity type, entity id — is what the
 * sweep compares against `alerts` rows: one row per condition, raised once,
 * escalated in place, resolved when the condition clears.
 */
export function dedupeKey(v) {
  return `${v.rule_id}|${v.entity_type}|${v.entity_id}`;
}

export function evaluateAll({ orders, deliveryJobs, reservations, tables }, nowMs, th = RULE_DEFAULTS) {
  return [
    ...evaluateOrders(orders, nowMs, th),
    ...evaluateDeliveryJobs(deliveryJobs, nowMs, th),
    ...evaluateReservations(reservations, nowMs, th),
    ...evaluateTables(tables, nowMs, th),
  ];
}
