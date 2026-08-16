import { d1Query, d1Run, json, readBody } from '../lib/db.js';
import { actorName } from '../auth.js';
import {
  computeWindow,
  normaliseDuration,
  holdsTable,
  isLapsedNoShow,
  ACTIVE_STATUSES,
  DEFAULT_DURATION_MIN,
  GRACE_MIN,
} from '../lib/booking.js';

const ACTIVE_LIST = ACTIVE_STATUSES.map((s) => `'${s}'`).join(', ');

function isManager(auth) {
  const role = auth && (auth.sessionRole || auth.role);
  return String(role || '').toLowerCase() === 'manager';
}


/**
 * Resolve whatever the client sent into a real table id.
 *
 * The POS previously posted `tableNum` while this handler only read `tableId`,
 * so the table silently vanished on every booking and all 15 production rows
 * carry an empty table_id. Accepting both, and checking the table actually
 * exists, is what makes a reservation refer to something.
 *
 * Returns { ok, tableId } or { ok:false, error }.
 */
async function resolveTableId(env, data) {
  const explicit = data.tableId || data.table_id;
  const byNumber = data.tableNum ?? data.table_number ?? data.tableNumber;

  if (!explicit && (byNumber === undefined || byNumber === null || String(byNumber).trim() === '')) {
    // A booking with no table is still legal - the host may assign it later -
    // but it holds nothing until it has one.
    return { ok: true, tableId: '' };
  }

  if (explicit) {
    const { results } = await d1Query(env, 'SELECT id FROM tables WHERE id = ?', [String(explicit)]);
    if (!results || !results.length) return { ok: false, error: `Unknown table ${explicit}` };
    return { ok: true, tableId: String(explicit) };
  }

  const n = Number(byNumber);
  if (!Number.isFinite(n)) return { ok: false, error: `Invalid table number ${byNumber}` };
  const { results } = await d1Query(env, 'SELECT id FROM tables WHERE number = ?', [n]);
  if (!results || !results.length) return { ok: false, error: `No table numbered ${n}` };
  return { ok: true, tableId: String(results[0].id) };
}

/** The booking that currently blocks `tableId` over a window, if any. */
async function findClash(env, tableId, startAt, endAt, excludeId) {
  const sql =
    `SELECT id, name, date, time, start_at, end_at FROM reservations
      WHERE table_id = ? AND table_id <> ''
        AND status IN (${ACTIVE_LIST})
        AND released_at IS NULL
        AND no_show_at IS NULL
        AND start_at IS NOT NULL AND end_at IS NOT NULL
        AND start_at < ? AND end_at > ?
        AND id <> ?
      LIMIT 1`;
  const { results } = await d1Query(env, sql, [tableId, endAt, startAt, excludeId || '']);
  return results && results.length ? results[0] : null;
}

function annotate(row, nowMs) {
  return Object.assign({}, row, {
    holdsTable: holdsTable(row, nowMs),
    lapsedNoShow: isLapsedNoShow(row, nowMs),
  });
}

async function handleReservations(pathname, method, request, env, auth) {
  const m = method.toUpperCase();
  const sub = pathname.replace(/^\/api\/reservations/, '');

  if (m === 'GET' && sub === '') {
    const { results } = await d1Query(env, 'SELECT * FROM reservations ORDER BY created DESC');
    const nowMs = Date.now();
    return json((results || []).map((r) => annotate(r, nowMs)));
  }

  // Which tables are unavailable for a given window - drives the booking form
  // so staff are not offered a table the server is about to reject.
  if (m === 'GET' && sub === '/availability') {
    const url = new URL(request.url);
    const window = computeWindow(
      url.searchParams.get('date'),
      url.searchParams.get('time'),
      url.searchParams.get('duration')
    );
    if (!window) return json({ ok: false, error: 'A valid date and time are required' }, 400);

    const sql =
      `SELECT table_id, id, name, start_at, end_at FROM reservations
        WHERE table_id <> '' AND status IN (${ACTIVE_LIST})
          AND released_at IS NULL AND no_show_at IS NULL
          AND start_at < ? AND end_at > ?`;
    const { results } = await d1Query(env, sql, [window.endAt, window.startAt]);
    return json({ ok: true, window, taken: results || [] });
  }

  if (m === 'POST' && sub === '') {
    const data = await readBody(request);
    if (!data) return json({ ok: false, error: 'Invalid JSON body' }, 400);

    const window = computeWindow(data.date, data.time, data.duration_min ?? data.durationMin);
    if (!window) {
      return json(
        { ok: false, error: 'A valid date (YYYY-MM-DD) and time are required' },
        400
      );
    }

    const resolved = await resolveTableId(env, data);
    if (!resolved.ok) return json({ ok: false, error: resolved.error }, 400);

    const id = data.id || 'R' + crypto.randomUUID().slice(0, 7);
    const nowIso = new Date().toISOString();
    const status = String(data.status || 'new');

    const params = [
      id,
      String(data.name || ''),
      String(data.phone || ''),
      String(data.email || ''),
      String(data.date || ''),
      String(data.time || ''),
      Number(data.guests) || 1,
      resolved.tableId,
      status,
      String(data.notes || ''),
      window.startAt,
      window.endAt,
      window.durationMin,
      nowIso,
    ];

    try {
      if (!resolved.tableId) {
        await d1Run(
          env,
          `INSERT INTO reservations
             (id, name, phone, email, "date", "time", guests, table_id, status, notes,
              start_at, end_at, duration_min, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params
        );
        return json({ ok: true, id, start_at: window.startAt, end_at: window.endAt });
      }

      // Exclusivity is enforced in one statement rather than by SELECT-then-
      // INSERT. Two hosts booking the same table at the same moment would both
      // pass a separate check and both insert; a conditional insert cannot
      // double-book because the condition is evaluated as part of the write.
      const insertIfFree =
        `INSERT INTO reservations
           (id, name, phone, email, "date", "time", guests, table_id, status, notes,
            start_at, end_at, duration_min, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM reservations
            WHERE table_id = ? AND table_id <> ''
              AND status IN (${ACTIVE_LIST})
              AND released_at IS NULL
              AND no_show_at IS NULL
              AND start_at IS NOT NULL AND end_at IS NOT NULL
              AND start_at < ? AND end_at > ?
         )`;

      const { meta } = await d1Run(env, insertIfFree, [
        ...params,
        resolved.tableId,
        window.endAt,
        window.startAt,
      ]);

      if (!meta.changes) {
        const clash = await findClash(env, resolved.tableId, window.startAt, window.endAt);
        return json(
          {
            ok: false,
            error: 'That table is already reserved for an overlapping time',
            conflict: clash || null,
          },
          409
        );
      }

      return json({ ok: true, id, start_at: window.startAt, end_at: window.endAt });
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 500);
    }
  }

  // ── Manager releases a held table ────────────────────────────────────────
  // Deliberately separate from a plain status edit: freeing a table someone has
  // booked is a decision that needs an owner, so it is manager-only and records
  // who did it.
  if (m === 'POST' && /^\/[^/]+\/release$/.test(sub)) {
    if (!isManager(auth)) {
      return json({ ok: false, error: 'Only a manager can release a reserved table' }, 403);
    }
    const id = sub.split('/')[1];
    const nowIso = new Date().toISOString();
    const { meta } = await d1Run(
      env,
      `UPDATE reservations
          SET released_at = ?, released_by = ?, status = 'cancelled', updated_at = ?
        WHERE id = ? AND released_at IS NULL`,
      [nowIso, actorName(auth), nowIso, id]
    );
    if (!meta.changes) {
      return json({ ok: false, error: 'Reservation not found or already released' }, 404);
    }
    return json({ ok: true, released_at: nowIso, released_by: actorName(auth) });
  }

  // Recording a no-show is ordinary floor work, so any signed-in member of
  // staff may do it; unlike a release it only confirms what already lapsed.
  if (m === 'POST' && /^\/[^/]+\/no-show$/.test(sub)) {
    const id = sub.split('/')[1];
    const nowIso = new Date().toISOString();
    const { meta } = await d1Run(
      env,
      `UPDATE reservations
          SET no_show_at = ?, status = 'cancelled', updated_at = ?
        WHERE id = ? AND no_show_at IS NULL`,
      [nowIso, nowIso, id]
    );
    if (!meta.changes) return json({ ok: false, error: 'Reservation not found' }, 404);
    return json({ ok: true, no_show_at: nowIso });
  }

  if (m === 'PUT' && sub.startsWith('/')) {
    const id = sub.slice(1);
    const data = await readBody(request);
    if (!data) return json({ ok: false, error: 'Invalid JSON body' }, 400);

    const { results } = await d1Query(env, 'SELECT * FROM reservations WHERE id = ?', [id]);
    if (!results || !results.length) return json({ ok: false, error: 'Reservation not found' }, 404);
    const existing = results[0];

    const fields = [];
    const values = [];
    const set = (col, val) => {
      fields.push(`${col} = ?`);
      values.push(val);
    };

    for (const col of ['status', 'name', 'phone', 'email', 'guests', 'notes']) {
      if (data[col] !== undefined) set(col, data[col]);
    }

    // Any change to when or where re-opens the exclusivity question, so the
    // window is recomputed and re-checked rather than patched field by field.
    const touchesWindow =
      data.date !== undefined ||
      data.time !== undefined ||
      data.duration_min !== undefined ||
      data.durationMin !== undefined ||
      data.tableId !== undefined ||
      data.table_id !== undefined ||
      data.tableNum !== undefined;

    if (touchesWindow) {
      const date = data.date !== undefined ? data.date : existing.date;
      const time = data.time !== undefined ? data.time : existing.time;
      const duration =
        data.duration_min ?? data.durationMin ?? existing.duration_min ?? DEFAULT_DURATION_MIN;

      const window = computeWindow(date, time, duration);
      if (!window) return json({ ok: false, error: 'A valid date and time are required' }, 400);

      let tableId = existing.table_id || '';
      if (data.tableId !== undefined || data.table_id !== undefined || data.tableNum !== undefined) {
        const resolved = await resolveTableId(env, data);
        if (!resolved.ok) return json({ ok: false, error: resolved.error }, 400);
        tableId = resolved.tableId;
      }

      if (tableId) {
        const clash = await findClash(env, tableId, window.startAt, window.endAt, id);
        if (clash) {
          return json(
            { ok: false, error: 'That table is already reserved for an overlapping time', conflict: clash },
            409
          );
        }
      }

      if (data.date !== undefined) set('date', String(data.date));
      if (data.time !== undefined) set('time', String(data.time));
      set('table_id', tableId);
      set('start_at', window.startAt);
      set('end_at', window.endAt);
      set('duration_min', window.durationMin);
    }

    if (!fields.length) return json({ ok: false, error: 'No fields to update' }, 400);

    set('updated_at', new Date().toISOString());
    values.push(id);

    const { meta } = await d1Run(
      env,
      `UPDATE reservations SET ${fields.join(', ')} WHERE id = ?`,
      values
    );
    if (!meta.changes) return json({ ok: false, error: 'Reservation not found' }, 404);
    return json({ ok: true });
  }

  if (m === 'DELETE' && sub.startsWith('/')) {
    const id = sub.slice(1);
    const { meta } = await d1Run(env, 'DELETE FROM reservations WHERE id = ?', [id]);
    if (!meta.changes) return json({ ok: false, error: 'Reservation not found' }, 404);
    return json({ ok: true });
  }

  return null;
}

export { handleReservations, resolveTableId, findClash, GRACE_MIN };
