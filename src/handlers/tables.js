import { d1Query, d1Run, json, readBody } from '../lib/db.js';
import { holdsTable, blocksSeating, ACTIVE_STATUSES, GRACE_MIN, SEATING_LEAD_MIN } from '../lib/booking.js';

const ACTIVE_LIST = ACTIVE_STATUSES.map((s) => `'${s}'`).join(', ');

/**
 * Statuses that mean "a party is at this table". Reserving is not seating, and
 * cleaning is not seating, so only these are gated.
 */
const SEATING_STATUSES = ['occupied'];

function isManager(auth) {
  const role = auth && (auth.sessionRole || auth.role);
  return String(role || '').toLowerCase() === 'manager';
}

function actorName(auth) {
  if (!auth) return 'unknown';
  return String(auth.name || auth.staffId || auth.id || auth.email || 'unknown');
}

/** Active, unresolved bookings, so callers can ask which still hold a table. */
async function activeReservations(env) {
  const { results } = await d1Query(
    env,
    `SELECT id, name, phone, guests, table_id, status, start_at, end_at,
            released_at, no_show_at
       FROM reservations
      WHERE table_id <> '' AND table_id IS NOT NULL
        AND status IN (${ACTIVE_LIST})
        AND released_at IS NULL
        AND no_show_at IS NULL
        AND start_at IS NOT NULL AND end_at IS NOT NULL`
  );
  return results || [];
}

/**
 * Tables and their current hold in one response.
 *
 * The floor plan needs to show a held table differently from a free one, and
 * deriving that on the client would mean shipping the grace-period rule to
 * every screen and keeping the copies in step. The server owns the rule; the
 * client renders what it is told.
 */
async function listTablesWithHolds(env) {
  const [{ results: tables }, reservations] = await Promise.all([
    d1Query(env, 'SELECT * FROM tables ORDER BY number'),
    activeReservations(env),
  ]);

  const nowMs = Date.now();
  const holdByTable = new Map();
  for (const r of reservations) {
    if (!holdsTable(r, nowMs)) continue;
    const current = holdByTable.get(r.table_id);
    // Earliest active hold wins - that is the booking a walk-in would displace.
    if (!current || Date.parse(r.start_at) < Date.parse(current.start_at)) {
      holdByTable.set(r.table_id, r);
    }
  }

  return (tables || []).map((t) => {
    const hold = holdByTable.get(t.id);
    return Object.assign({}, t, {
      // A booking is shown all day, but blocksNow says whether it is actually
      // taking the table out of service yet. The floor plan needs both: "this
      // is spoken for at 21:00" is useful at lunchtime, but it must not read
      // as "you cannot use this table".
      reservedHold: hold
        ? {
            id: hold.id,
            name: hold.name,
            guests: hold.guests,
            startAt: hold.start_at,
            endAt: hold.end_at,
            blocksNow: blocksSeating(hold, nowMs),
          }
        : null,
    });
  });
}

/**
 * The seating gate.
 *
 * Runs before the generic resource handler so that a table held by a booking
 * cannot be flipped to occupied by anyone except a manager. Enforced here and
 * not in the UI because hiding a button stops nothing: the endpoint is
 * reachable directly, and the floor plan is not the only client.
 */
async function handleTables(pathname, method, url, request, env, auth) {
  const m = method.toUpperCase();
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'api' || parts[1] !== 'tables') return null;

  if (m === 'GET' && parts.length === 2) {
    return json(await listTablesWithHolds(env));
  }

  if (m === 'PUT' && parts.length === 3) {
    const tableId = parts[2];
    // Clone before reading: a request body can only be consumed once, and this
    // handler deliberately falls through to the generic resource handler, which
    // reads the same body to perform the update.
    let data;
    try {
      data = await readBody(request.clone());
    } catch {
      return null; // let the generic handler produce the usual error
    }
    if (!data) return null;

    const nextStatus = String(data.status || '').toLowerCase();
    if (!SEATING_STATUSES.includes(nextStatus)) return null; // not a seating change

    const { results } = await d1Query(
      env,
      `SELECT id, name, guests, status, start_at, end_at, released_at, no_show_at
         FROM reservations
        WHERE table_id = ?
          AND status IN (${ACTIVE_LIST})
          AND released_at IS NULL
          AND no_show_at IS NULL
          AND start_at IS NOT NULL AND end_at IS NOT NULL`,
      [tableId]
    );

    const nowMs = Date.now();
    // blocksSeating, not holdsTable: a booking later today is shown on the floor
    // plan but must not stop the table being used until its lead time.
    const hold = (results || []).find((r) => blocksSeating(r, nowMs));
    if (!hold) return null; // nothing blocks it - proceed as normal

    if (!isManager(auth)) {
      return json(
        {
          ok: false,
          error: 'This table is reserved. A manager must release it before it can be seated.',
          reservation: {
            id: hold.id,
            name: hold.name,
            guests: hold.guests,
            startAt: hold.start_at,
            endAt: hold.end_at,
          },
          graceMinutes: GRACE_MIN,
          leadMinutes: SEATING_LEAD_MIN,
        },
        409
      );
    }

    // A manager seating a held table is an override, and leaving the booking
    // active would show the same table as both reserved and occupied. Releasing
    // it here keeps the two consistent and records who decided.
    const nowIso = new Date().toISOString();
    await d1Run(
      env,
      `UPDATE reservations
          SET released_at = ?, released_by = ?, status = 'cancelled', updated_at = ?
        WHERE id = ? AND released_at IS NULL`,
      [nowIso, actorName(auth), nowIso, hold.id]
    );

    return null; // fall through so the generic handler performs the update
  }

  return null;
}

export { handleTables, listTablesWithHolds, SEATING_STATUSES };
