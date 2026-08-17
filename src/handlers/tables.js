import { d1Query, d1Run, json, readBody } from '../lib/db.js';
import { holdsTable, blocksSeating, isNewSeating, ACTIVE_STATUSES, GRACE_MIN, SEATING_LEAD_MIN } from '../lib/booking.js';
import { actorName } from '../auth.js';

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
 * Take the table, or lose the race.
 *
 * Checking "is it free?" and then writing is two statements, and two waiters
 * who both read "free" both write. The condition therefore lives *in* the
 * write: SQLite applies it atomically, so of two simultaneous claims exactly
 * one reports a changed row and the other is told who beat it.
 *
 * Returns null when the caller should fall through to the generic handler,
 * which applies the rest of the fields (guests, server, notes).
 */
async function claimSeat(env, table, data, claimingNewSeat) {
  if (!claimingNewSeat) return null; // editing the party already seated

  const seatedAt = String(data.seated_at || '').trim() || new Date().toISOString();
  const { meta } = await d1Run(
    env,
    `UPDATE tables
        SET status = 'occupied', seated_at = ?
      WHERE id = ?
        AND (status <> 'occupied' OR seated_at IS NULL OR TRIM(seated_at) = '')`,
    [seatedAt, table.id]
  );

  if (!meta.changes) {
    const { results } = await d1Query(
      env,
      'SELECT number, server, guests, seated_at FROM tables WHERE id = ?',
      [table.id]
    );
    const now = (results || [])[0] || table;
    return json(
      {
        ok: false,
        error: `Table ${now.number} was just taken by someone else. Refresh the floor plan.`,
        occupiedBy: {
          server: now.server || null,
          guests: now.guests || 0,
          seatedAt: now.seated_at || null,
        },
      },
      409
    );
  }

  return null; // claimed - let the generic handler write the remaining fields
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

    // ── Is somebody already sitting here? ────────────────────────────────────
    // A table holds one party at a time. Four screens can send this same write
    // (floor plan, menu send-to-kitchen, orders, checkout), so the rule lives
    // here rather than in any of them.
    const { results: tableRows } = await d1Query(
      env,
      'SELECT id, number, status, server, guests, seated_at FROM tables WHERE id = ?',
      [tableId]
    );
    const table = (tableRows || [])[0];
    if (!table) return null; // let the generic handler answer 404

    // `newSeating` is the caller stating intent: a waiter starting a fresh party
    // rather than adding a round to the tab already on the table. The server
    // cannot infer it — a client that just refetched the row echoes back the
    // stored seated_at either way — so the flag only ever makes the check
    // stricter, never laxer. It is not a table column, so the generic handler
    // filters it out before the write.
    const claimingNewSeat = data.newSeating === true || isNewSeating(table, data.seated_at);
    const alreadyOccupied = String(table.status || '').toLowerCase() === 'occupied';

    if (claimingNewSeat && alreadyOccupied && !isManager(auth)) {
      return json(
        {
          ok: false,
          error: `Table ${table.number} already has a party seated. Clear it or pick another table.`,
          occupiedBy: {
            server: table.server || null,
            guests: table.guests || 0,
            seatedAt: table.seated_at || null,
          },
        },
        409
      );
    }

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
    if (!hold) return claimSeat(env, table, data, claimingNewSeat);

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

    // A manager overriding is deliberate, so the claim is unconditional: they
    // have already been told what they are taking.
    return claimingNewSeat && !alreadyOccupied
      ? claimSeat(env, table, data, claimingNewSeat)
      : null;
  }

  return null;
}

export { handleTables, listTablesWithHolds, SEATING_STATUSES };
