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
import { parseFlatItems } from './timing.js';

/** Severity words, one place. */
export const SEVERITY = { WARNING: 'warning', CRITICAL: 'critical' };

/**
 * Station values an order-stage alert can carry.
 *
 * The floor is split into two stations — the bar makes the drinks, the
 * kitchen makes everything else — and an SLA breach on a ticket is that
 * station's problem, not the whole room's. Station lives on the alert row
 * (alerts.station) so the audience filter can route it; 'mixed' means both
 * stations hold unfinished work on the same ticket and both hear about it.
 */
export const STATION = { BAR: 'bar', KITCHEN: 'kitchen', MIXED: 'mixed', NONE: '' };

/**
 * The rules, by stable id. These strings are stored in `alerts.rule_id` and
 * referenced by tests and screens; renaming one orphans every open alert.
 */
export const RULE_IDS = {
  PREPARING_TOO_LONG: 'order-preparing-too-long',
  NEW_UNACCEPTED: 'order-new-unaccepted',
  READY_NOW: 'order-ready-now',
  READY_NOT_SERVED: 'order-ready-not-served',
  DELIVERY_UNASSIGNED: 'delivery-ready-unassigned',
  DELIVERY_IN_TRANSIT: 'delivery-in-transit-too-long',
  SERVED_UNPAID: 'order-served-unpaid',
  RESERVATION_NO_SHOW: 'reservation-no-show',
  TABLE_SEATED_TOO_LONG: 'table-seated-too-long',
  FORGOT_CLOCK_OUT: 'employee-forgot-clock-out',
  EMPLOYEE_LATE: 'employee-late-arrival',
};

/**
 * What counts as a drink, for station routing.
 *
 * Mirror — word for word — of the POS's lib/drinks.js regex, because a ticket
 * the boards route to the bar cannot have its alert land on the kitchen. The
 * two lists must move together; test/rules.test.js pins a few names on both
 * sides of the line to make a silent drift loud.
 */
export const DRINK_WORDS = /drink|coffee|beverage|juice|water|soda|\bbar\b|\btea\b|latte|espresso|cappuccino|macchiato|americano|mocha|smoothie|shake|lemonade/i;

export function nameIsDrink(name) {
  return DRINK_WORDS.test(String(name || ''));
}

/**
 * Which station(s) own the work on this order.
 *
 * Reads whatever item summary the row carries — the JSON line array the POS
 * writes today, or the legacy flat "2xLatte, 1xFut breakfast" string — and
 * classifies each line by the drink word list above. Returns:
 *   'bar'     every line is a drink — the barista's ticket alone
 *   'kitchen' no line is a drink — the kitchen's ticket alone
 *   'mixed'   both stations hold lines — both hear the alert
 *   ''        the items cannot be parsed into lines at all — legacy free
 *             text. The alert falls back to the kitchen audience, which was
 *             the whole room before the split existed.
 */
export function orderStation(order) {
  if (!order) return STATION.NONE;
  let lines = order.items;
  if (typeof lines === 'string') {
    const t = lines.trim();
    if (t.startsWith('[') && t.endsWith(']')) {
      try {
        lines = JSON.parse(t);
      } catch {
        lines = parseFlatItems(t);
        if (!lines.length) return STATION.NONE;
      }
    } else {
      lines = parseFlatItems(t);
      if (!lines.length) return STATION.NONE;
    }
  }
  if (!Array.isArray(lines)) return STATION.NONE;
  const named = (lines || [])
    .map((l) => (l && typeof l === 'object' ? String(l.name || '') : ''))
    .filter(Boolean);
  if (!named.length) return STATION.NONE;
  const drinks = named.filter((n) => nameIsDrink(n)).length;
  if (drinks === 0) return STATION.KITCHEN;
  if (drinks === named.length) return STATION.BAR;
  return STATION.MIXED;
}

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
  forgotClockOutMin: 600, // 10 hours — a shift that is still open this long was forgotten
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

function violation(ruleId, severity, entityType, entityId, label, message, extra) {
  return {
    rule_id: ruleId,
    severity,
    entity_type: entityType,
    entity_id: String(entityId),
    entity_label: label,
    message,
    ...(extra || {}),
  };
}

/** Order-stage violations carry the station so the audience can route them. */
function orderViolation(ruleId, severity, order, label, message) {
  return violation(ruleId, severity, 'order', order.id, label, message, {
    station: orderStation(order),
  });
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
      return orderViolation(
        RULE_IDS.NEW_UNACCEPTED, SEVERITY.WARNING, order,
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
      return orderViolation(
        RULE_IDS.PREPARING_TOO_LONG, severity, order,
        orderLabel(order),
        `${orderLabel(order)} in preparing for ${fmtMin(age)} (limit ${th.preparingWarnMin} min${severity === SEVERITY.CRITICAL ? `, critical at ${th.preparingCriticalMin}` : ''})`
      );
    }
    return null;
  }

  if (status === 'ready' && !isDelivery) {
    const age = firstStamp(nowMs, order.ready_at, order.updated_at, order.created);
    if (age !== null && age > th.readyUnservedMin) {
      return orderViolation(
        RULE_IDS.READY_NOT_SERVED, SEVERITY.WARNING, order,
        orderLabel(order),
        `${orderLabel(order)} — ready ${fmtMin(age)}, not served (limit ${th.readyUnservedMin} min)`
      );
    }
    return null;
  }

  if ((status === 'served' || status === 'fulfilled') && UNPAID.has(String(order.payment_status || '').toLowerCase())) {
    const age = firstStamp(nowMs, order.served_at, order.updated_at, order.created);
    if (age !== null && age > th.servedUnpaidMin) {
      return orderViolation(
        RULE_IDS.SERVED_UNPAID, SEVERITY.WARNING, order,
        orderLabel(order),
        `${orderLabel(order)} — served ${fmtMin(age)} ago, bill still open (limit ${th.servedUnpaidMin} min)`
      );
    }
    return null;
  }

  return null;
}

/**
 * The instant pickup ping: food or drink is ready, someone has to fetch it.
 *
 * Where READY_NOT_SERVED is the escalation that fires only after the pickup
 * window has already slipped, this rule fires the moment an order enters
 * 'ready' — raised in real time by the orders handler on the status
 * transition, and kept alive here by the sweep for as long as the ticket
 * sits uncollected (so a ping nobody acted on is never lost, and the row
 * resolves itself the moment the order is served).
 *
 * The audience is the waiting staff, not the station that made the thing:
 * the row targets the waiter assigned to the table (alerts.target_staff_id,
 * resolved by the sweep/handler from tables.server), falling back to the
 * order's creator for takeaways, and to every head-waiter when neither
 * resolves. This function only states the condition and names the
 * candidate: the caller stamps target_staff_id after matching names to
 * staff, which is why the violation carries table_server/created_by raw.
 */
export function evaluateOrderReadyNow(order) {
  if (!order || !order.id) return null;
  if (String(order.status || '').toLowerCase() !== 'ready') return null;
  const label = orderLabel(order);
  const server = String(order.table_server || '').trim();
  const message = server
    ? `${label} — order ready for pickup (waiter: ${server})`
    : `${label} — order ready for pickup`;
  return violation(
    RULE_IDS.READY_NOW, SEVERITY.WARNING, 'order', order.id, label, message,
    { station: orderStation(order), target_name: server, created_by: order.created_by || '' }
  );
}

/** Every ready-now ping in one pass. */
export function evaluateOrdersReadyNow(orders) {
  const out = [];
  for (const o of orders || []) {
    const v = evaluateOrderReadyNow(o);
    if (v) out.push(v);
  }
  return out;
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
 * Did this employee forget to clock out?
 *
 * A timeclock entry that is still 'active' (clock_out is empty) more than
 * `forgotClockOutMin` minutes after clock_in was almost certainly left open
 * when the person went home. The shift gate (clockOut handler) refuses
 * clock-out when checks are open, so this is also a signal that money may
 * be owed on tables nobody is watching.
 */
export function evaluateTimeclock(entry, nowMs, th = RULE_DEFAULTS) {
  if (!entry || !entry.id) return null;
  // Only open entries (no clock_out)
  if (entry.clock_out && String(entry.clock_out).trim() !== '') return null;
  if (String(entry.status || '').toLowerCase() === 'completed') return null;

  // clock_in is stored as "HH:MM" (shop local time), not an ISO timestamp.
  // Reconstruct a comparable instant by combining the entry's date + clock_in.
  const dateStr = String(entry.date || '').slice(0, 10);
  const timeStr = String(entry.clock_in || '').trim();
  if (!dateStr || !timeStr) return null;
  const inMs = Date.parse(`${dateStr}T${timeStr.length === 5 ? timeStr + ':00' : timeStr}Z`);
  if (!Number.isFinite(inMs)) return null;
  const age = (nowMs - inMs) / 60000;
  if (age <= th.forgotClockOutMin) return null;

  const name = [entry.firstName, entry.lastName].filter(Boolean).join(' ') || entry.staff_id;
  return violation(
    RULE_IDS.FORGOT_CLOCK_OUT, SEVERITY.WARNING, 'timeclock', entry.id,
    `${name} — shift still open`,
    `${name} clocked in ${fmtMin(age)} ago and has not clocked out (limit ${fmtMin(th.forgotClockOutMin)}). Check if they forgot, or if open checks are blocking clock-out.`
  );
}

/** Every forgotten-clock-out violation in one pass. */
export function evaluateTimeclockEntries(entries, nowMs, th = RULE_DEFAULTS) {
  const out = [];
  for (const e of entries || []) {
    const v = evaluateTimeclock(e, nowMs, th);
    if (v) out.push(v);
  }
  return out;
}

/**
 * One sweep over everything.
 *
 * Takes the collections already loaded by the caller and returns every
 * live violation. The dedupe key — rule, entity type, entity id — is what the
 * sweep compares against `alerts` rows: one row per condition, raised once,
 * escalated in place, resolved when the condition clears.
 */
export function dedupeKey(v) {
  return `${v.rule_id}|${v.entity_type}|${v.entity_id}`;
}

export function evaluateAll({ orders, deliveryJobs, reservations, tables, timeclockEntries }, nowMs, th = RULE_DEFAULTS) {
  return [
    ...evaluateOrders(orders, nowMs, th),
    ...evaluateOrdersReadyNow(orders),
    ...evaluateDeliveryJobs(deliveryJobs, nowMs, th),
    ...evaluateReservations(reservations, nowMs, th),
    ...evaluateTables(tables, nowMs, th),
    ...evaluateTimeclockEntries(timeclockEntries, nowMs, th),
  ];
}
