/**
 * Booking rules: turning what staff type into a comparable time window, and
 * deciding when a reservation still holds a table.
 *
 * Everything here is pure. Table exclusivity is the kind of rule that is
 * expensive to get wrong and impossible to test through a UI, so the decisions
 * live in functions that take values and return values, and the handlers only
 * wire them to the database.
 */

/**
 * The shop is in Ethiopia (UTC+3, no daylight saving), and staff enter local
 * wall-clock time. Storing that string as if it were UTC would put every
 * booking three hours out, so "is this table held right now" would be wrong for
 * three hours a day. The offset is fixed because EAT has no DST; a chain in a
 * second timezone would make this per-venue.
 */
export const SHOP_UTC_OFFSET_MIN = 180;

/** Default hold length when nobody specifies one. */
export const DEFAULT_DURATION_MIN = 90;

/**
 * How long a table is still held after the booked time passes. The industry
 * norm is 15 minutes. Without it, a no-show holds a table for its whole window
 * and the floor loses a table for the evening because the one person allowed to
 * release it is busy.
 */
export const GRACE_MIN = 15;

/**
 * How long before a booking the table stops accepting walk-ins.
 *
 * Without this, a booking held its table from the moment it was taken, so a
 * 21:00 reservation made in the morning cost the floor that table for the whole
 * day - one evening cover wiping out a lunch and an afternoon on a 90-minute
 * turn. An hour is enough to clear, reset and lay a table while leaving the
 * rest of the day sellable.
 *
 * This applies only to seating. It deliberately does NOT relax double-booking:
 * a second reservation for the same table and time is still refused however far
 * off it is, because that is a promise to a guest rather than a use of the room.
 */
export const SEATING_LEAD_MIN = 60;

const ACTIVE_STATUSES = ['new', 'confirmed'];

/**
 * Minutes past midnight from the formats actually present in production, which
 * are not consistent: "18:30" and "7:00 AM" both exist in the same column.
 * Returns null when the value cannot be understood, so callers can reject the
 * write rather than silently storing a booking nobody can compare.
 */
export function parseTimeToMinutes(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return null;

  const m = raw.match(/^(\d{1,2})[:.](\d{2})\s*([AaPp][Mm])?$/);
  if (!m) return null;

  let hour = Number(m[1]);
  const min = Number(m[2]);
  const suffix = m[3] ? m[3].toLowerCase() : '';

  if (!Number.isFinite(hour) || !Number.isFinite(min)) return null;
  if (min > 59) return null;

  if (suffix) {
    // 12-hour clock: 12am is 00, 12pm is 12.
    if (hour < 1 || hour > 12) return null;
    if (hour === 12) hour = 0;
    if (suffix === 'pm') hour += 12;
  } else if (hour > 23) {
    return null;
  }

  return hour * 60 + min;
}

/** Strict YYYY-MM-DD, rejecting impossible dates like 2026-02-31. */
export function parseDate(value) {
  const raw = String(value == null ? '' : value).trim();
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    return null;
  }
  return ms;
}

/**
 * Local date + local time + duration -> an absolute UTC window.
 * Returns null when either input is unparseable.
 */
export function computeWindow(date, time, durationMin) {
  const dayMs = parseDate(date);
  const minutes = parseTimeToMinutes(time);
  if (dayMs === null || minutes === null) return null;

  const duration = normaliseDuration(durationMin);
  const startMs = dayMs + minutes * 60000 - SHOP_UTC_OFFSET_MIN * 60000;
  const endMs = startMs + duration * 60000;

  return {
    startAt: new Date(startMs).toISOString(),
    endAt: new Date(endMs).toISOString(),
    durationMin: duration,
  };
}

/** Clamp to something a service can actually mean: 15 minutes to 12 hours. */
export function normaliseDuration(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DURATION_MIN;
  return Math.min(Math.max(Math.round(n), 15), 720);
}

/**
 * Half-open overlap: a booking ending exactly when the next begins does not
 * clash, so back-to-back sittings on one table are allowed. Using closed
 * intervals here would reject the most common real booking pattern.
 */
export function windowsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

export function isActiveStatus(status) {
  return ACTIVE_STATUSES.includes(String(status || '').toLowerCase());
}

export { ACTIVE_STATUSES };

/**
 * Does this reservation still hold its table at `nowMs`?
 *
 * A booking holds the table from the moment it is made until its window ends,
 * except that once the guest is more than the grace period late and has not
 * been seated, the hold lapses and the table returns to the floor. Released and
 * cancelled bookings never hold.
 */
export function holdsTable(reservation, nowMs, graceMin = GRACE_MIN) {
  if (!reservation) return false;
  if (reservation.released_at) return false;
  if (reservation.no_show_at) return false;
  if (!isActiveStatus(reservation.status)) return false;

  const start = Date.parse(reservation.start_at);
  const end = Date.parse(reservation.end_at);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;

  if (nowMs >= end) return false;

  // Late beyond grace, and nobody sat down: the table is free again.
  if (nowMs > start + graceMin * 60000) return false;

  return true;
}

/**
 * Should this booking stop a walk-in being seated *right now*?
 *
 * Narrower than holdsTable on purpose, and this is the difference that matters:
 * a booking that exists is worth showing on the floor plan all day, but it only
 * takes the table out of service once the lead time is reached. Showing and
 * blocking are different questions and were previously answered the same way,
 * which made every future booking an all-day blockade.
 */
export function blocksSeating(reservation, nowMs, graceMin = GRACE_MIN, leadMin = SEATING_LEAD_MIN) {
  if (!holdsTable(reservation, nowMs, graceMin)) return false;
  const start = Date.parse(reservation.start_at);
  if (!Number.isFinite(start)) return false;
  return nowMs >= start - leadMin * 60000;
}

/** Bookings whose grace has expired and which nobody has marked yet. */
export function isLapsedNoShow(reservation, nowMs, graceMin = GRACE_MIN) {
  if (!reservation) return false;
  if (reservation.released_at || reservation.no_show_at) return false;
  if (!isActiveStatus(reservation.status)) return false;
  const start = Date.parse(reservation.start_at);
  if (!Number.isFinite(start)) return false;
  return nowMs > start + graceMin * 60000;
}
