/**
 * State that nobody closed.
 *
 * Two things in this system stay true until somebody says otherwise, and on a
 * busy floor nobody does: a table stays occupied and a ticket stays on the
 * kitchen board. Live data showed the cost — a table seated four days earlier
 * and still holding the floor plan, and six tickets sitting as `new` since
 * 31 July, the oldest three weeks old. A chef scrolling past three weeks of
 * dead tickets stops reading the board.
 *
 * Everything here is pure so the thresholds can be tested without a database,
 * for the same reason booking.js is.
 */

/**
 * Well past any real sitting. A cafe turns in under an hour and a restaurant
 * in about two, so four hours is not "your guests are lingering" — it is
 * nobody ever cleared the table. Deliberately generous: releasing a table with
 * people at it is worse than leaving one occupied a little too long.
 */
export const DEFAULT_TABLE_MAX_HOURS = 4;

/**
 * The kitchen already calls a ticket critical at 15 minutes. This is not that
 * alarm — it is the point past which a ticket is certainly not being cooked
 * and is only in the way.
 */
export const DEFAULT_KITCHEN_STALE_HOURS = 4;

/**
 * One spelling for a table reference.
 *
 * `table_id` on orders is a string, and production holds "3", "03", "7" and
 * "7.0" for what are four references to two tables. Every screen compares it
 * as a string, so an order written as "7.0" belongs to no table: the floor
 * plan shows no open tab and Add Round cannot find it.
 *
 * Only unambiguous numeric forms are touched. A venue that labels a table
 * "A1" or "Patio 2" keeps exactly what it typed.
 */
export function normaliseTableId(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d+(\.0+)?$/.test(raw)) return String(parseInt(raw, 10));
  return raw;
}

/** Milliseconds since an ISO-ish stamp, or null when it cannot be read. */
export function msSince(stamp, nowMs) {
  const t = Date.parse(String(stamp || '').trim());
  if (!Number.isFinite(t)) return null;
  return nowMs - t;
}

/**
 * Has this table been held long enough that nobody is sitting at it?
 *
 * A table with no seated_at is not judged: production has one, and guessing an
 * age for it would either free a live table or never free a dead one. The
 * sweep stamps those instead so they start ageing from when they were noticed.
 */
export function tableOverstayed(table, nowMs, maxHours = DEFAULT_TABLE_MAX_HOURS) {
  if (!table) return false;
  if (String(table.status || '').toLowerCase() !== 'occupied') return false;
  const age = msSince(table.seated_at, nowMs);
  if (age === null) return false;
  return age > maxHours * 3600000;
}

/**
 * Should this ticket have dropped off the kitchen board?
 *
 * A question about the board only. The order is untouched and still appears in
 * Orders and, if money is owed on it, in Open Checks — hiding an unpaid bill
 * is the one thing this must not do.
 */
export function ticketStale(order, nowMs, staleHours = DEFAULT_KITCHEN_STALE_HOURS) {
  if (!order) return false;
  const age = msSince(order.created, nowMs);
  if (age === null) return false;
  return age > staleHours * 3600000;
}
