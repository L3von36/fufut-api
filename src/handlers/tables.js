import { d1Query, d1Run, json, readBody } from '../lib/db.js';
import { holdsTable, blocksSeating, isNewSeating, ACTIVE_STATUSES, GRACE_MIN, SEATING_LEAD_MIN } from '../lib/booking.js';
import { actorName } from '../auth.js';
import { writeAudit } from '../lib/audit.js';
import { tableOverstayed, normaliseTableId, DEFAULT_TABLE_MAX_HOURS } from '../lib/staleness.js';
import { generateTableKey, tableOrderUrl } from '../lib/tablekey.js';

const ACTIVE_LIST = ACTIVE_STATUSES.map((s) => `'${s}'`).join(', ');

/**
 * Statuses that mean "a party is at this table". Reserving is not seating, and
 * cleaning is not seating, so only these are gated.
 */
const SEATING_STATUSES = ['occupied'];

// ─── Floor zones (the sections tables live in) ──────────────────────────────
// Zones used to be a hardcoded array in the POS — renaming "Patio" or adding a
// "Terrace" meant a developer and a deploy. They are data now, like the tax
// bands before them: one settings row (`tables.sections`) holds the ordered
// list, and every write that changes a name carries its tables along, because
// a zone renamed out from under six tables would strand them in a zone the
// pickers no longer offer.
const SECTIONS_KEY = 'tables.sections';
const DEFAULT_SECTIONS = ['Patio', 'Main Hall', 'Window', 'VIP Room', 'Bar'];
// Miller's seven-plus-or-minus-two: a working memory holds about seven items,
// and the zone picker is exactly such a list — scanned dozens of times a
// shift, on a phone. Nine is the hard ceiling the API enforces; the editor
// shows the counter so the manager sees the budget before hitting it.
const MAX_SECTIONS = 9;
const SECTION_NAME_MAX = 24;

/**
 * The validator for a zones list. Accepts the parsed array or the raw JSON
 * string (settings arrive as strings), and returns a plain-English error or
 * null — the same convention as incomeBandError, so putSetting can guard the
 * key the same way it guards tax.income_bands.
 */
export function sectionsError(value) {
  let list = value;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      return 'Zones must be a JSON list of names, e.g. ["Patio","Main Hall","Bar"].';
    }
  }
  if (!Array.isArray(list)) {
    return 'Zones must be a list of names, e.g. ["Patio","Main Hall","Bar"].';
  }
  if (list.length < 1) return 'Keep at least one zone — every table needs somewhere to live.';
  if (list.length > MAX_SECTIONS) {
    return `Keep the list to ${MAX_SECTIONS} zones or fewer — past that the picker stops being scannable at a glance.`;
  }
  const seen = new Set();
  for (let i = 0; i < list.length; i++) {
    const raw = list[i];
    if (typeof raw !== 'string') return `Zone ${i + 1} is not a name.`;
    const name = raw.trim();
    if (!name) return `Zone ${i + 1} is empty.`;
    if (name.length > SECTION_NAME_MAX) {
      return `"${name}" is ${name.length} characters — keep zone names to ${SECTION_NAME_MAX} or fewer so chips and pickers stay readable.`;
    }
    if (/[\u0000-\u001f<>]/.test(name)) {
      return `"${name}" contains characters zone names cannot use.`;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      return `Two zones are named "${name}" (spelling differs only by capitalisation). Zone names must be distinct.`;
    }
    seen.add(key);
  }
  return null;
}

/**
 * The stored list, or null when none is stored (or it no longer validates —
 * a corrupt row must degrade to the defaults, never break the floor plan).
 */
async function storedSections(env) {
  const { results } = await d1Query(env, 'SELECT value FROM settings WHERE key = ?', [SECTIONS_KEY]);
  const row = (results || [])[0];
  if (!row) return null;
  try {
    const list = JSON.parse(row.value);
    if (sectionsError(list)) return null;
    return list.map((s) => String(s).trim());
  } catch {
    return null;
  }
}

/** How many tables sit in each zone today, by trimmed name. */
async function sectionsUsage(env) {
  const { results } = await d1Query(
    env,
    "SELECT TRIM(section) AS section, COUNT(*) AS n FROM tables WHERE section IS NOT NULL AND TRIM(section) <> '' GROUP BY TRIM(section)"
  );
  const usage = {};
  for (const r of results || []) usage[String(r.section)] = r.n;
  return usage;
}

/**
 * The working list: stored order first, then any zone that exists only on
 * tables (legacy free-text values a manager typed before zones were data).
 * Tables must never fall out of a picker because the setting moved on.
 */
async function workingSections(env) {
  const fromDb = await storedSections(env);
  const stored = fromDb || [...DEFAULT_SECTIONS];
  const usage = await sectionsUsage(env);
  const have = new Set(stored.map((s) => s.toLowerCase()));
  const extras = Object.keys(usage).filter((s) => !have.has(s.toLowerCase()));
  // `fromDb` (not the effective list) is what says whether the manager has
  // customised anything — the UI uses it to show defaults vs custom.
  return { list: [...stored, ...extras], usage, stored: fromDb };
}

/** Persist the list and write the one audit entry that describes the change. */
async function saveSections(env, auth, list, { beforeValue, moved = 0, reason }) {
  const value = JSON.stringify(list);
  const nowIso = new Date().toISOString();
  const by = auth ? actorName(auth) : null;
  const { results } = await d1Query(env, 'SELECT value FROM settings WHERE key = ?', [SECTIONS_KEY]);
  if ((results || [])[0]) {
    await d1Run(env, 'UPDATE settings SET value = ?, updated_at = ?, updated_by = ? WHERE key = ?', [
      value, nowIso, by, SECTIONS_KEY,
    ]);
  } else {
    await d1Run(
      env,
      "INSERT INTO settings (key, value, category, label, updated_at, updated_by) VALUES (?, ?, 'tables', 'Floor zones', ?, ?)",
      [SECTIONS_KEY, value, nowIso, by]
    );
  }
  await writeAudit(env, auth, {
    action: 'update',
    entity: 'settings',
    entityId: SECTIONS_KEY,
    before: beforeValue != null ? { value: beforeValue } : null,
    after: { value, tables_moved: moved },
    reason,
  });
  return value;
}

/**
 * Zone edits. One endpoint, four verbs of intent, because they all mutate the
 * same list and all of them except `add` may carry tables with them.
 *
 *   rename  { from, to }   — renames the zone and every table sitting in it
 *   add     { name }       — appends a zone (capped at MAX_SECTIONS)
 *   remove  { name, moveTo } — deletes a zone; if tables live there, `moveTo`
 *                            says which surviving zone absorbs them
 *   reorder { sections }   — the same zones, new order (pickers keep order)
 *
 * Manager-only: the floor layout is the manager's decision the same way the
 * server-on-table assignment is. Audited, because a rename that moved twelve
 * tables will be asked about.
 */
async function handleSections(pathname, method, request, env, auth) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'api' || parts[1] !== 'tables' || parts[2] !== 'sections') return null;
  const m = method.toUpperCase();

  // Reads are open to every signed-in role: the POS filter, the Add Table
  // form and the backoffice editor all render from this, and head-waiters
  // need the zones to read their own floor. Writes are the manager's.
  if (m === 'GET') {
    const { list, usage, stored } = await workingSections(env);
    return json({
      ok: true,
      sections: list,
      usage,
      custom: Boolean(stored),
      max: MAX_SECTIONS,
      nameMax: SECTION_NAME_MAX,
    });
  }

  if (m === 'POST') {
    if (!isManager(auth)) return json({ ok: false, error: 'Manager access required' }, 403);

    const data = await readBody(request);
    if (!data || !data.action) {
      return json({ ok: false, error: 'Send an action: rename, add, remove or reorder.' }, 400);
    }

    const { list: work, usage } = await workingSections(env);
    const findIdx = (name) =>
      work.findIndex((s) => s.toLowerCase() === String(name || '').trim().toLowerCase());
    const lower = (arr) => arr.map((s) => s.trim().toLowerCase());

    if (data.action === 'rename') {
      const from = String(data.from || '').trim();
      const to = String(data.to || '').trim();
      if (!from) return json({ ok: false, error: 'Send the zone to rename as "from".' }, 400);
      const at = findIdx(from);
      if (at === -1) return json({ ok: false, error: `No zone named "${from}" on the floor.` }, 404);
      const nameError = sectionsError([to]);
      if (nameError) return json({ ok: false, error: nameError }, 400);
      if (work.some((s, i) => i !== at && s.toLowerCase() === to.toLowerCase())) {
        return json({ ok: false, error: `"${to}" is already a zone. Rename to something distinct.` }, 400);
      }
      const beforeValue = JSON.stringify(work);
      const next = work.map((s) => (s.toLowerCase() === from.toLowerCase() ? to : s));
      const { meta } = await d1Run(
        env,
        'UPDATE tables SET section = ? WHERE LOWER(TRIM(section)) = LOWER(?)',
        [to, from]
      );
      const moved = meta ? meta.changes : 0;
      await saveSections(env, auth, next, {
        beforeValue,
        moved,
        reason: `Zone "${from}" renamed to "${to}"${moved ? ` — ${moved} table${moved === 1 ? '' : 's'} moved with it` : ''}`,
      });
      return json({ ok: true, sections: next, tablesMoved: moved });
    }

    if (data.action === 'add') {
      const name = String(data.name || '').trim();
      const nameError = sectionsError([name]);
      if (nameError) return json({ ok: false, error: nameError }, 400);
      if (findIdx(name) !== -1) {
        return json({ ok: false, error: `"${name}" is already a zone.` }, 400);
      }
      if (work.length + 1 > MAX_SECTIONS) {
        return json(
          {
            ok: false,
            error: `${MAX_SECTIONS} zones is the limit — the picker has to stay scannable. Merge or rename instead.`,
          },
          400
        );
      }
      const beforeValue = JSON.stringify(work);
      const next = [...work, name];
      await saveSections(env, auth, next, {
        beforeValue,
        reason: `Zone "${name}" added to the floor plan`,
      });
      return json({ ok: true, sections: next });
    }

    if (data.action === 'remove') {
      const name = String(data.name || '').trim();
      const at = findIdx(name);
      if (at === -1) return json({ ok: false, error: `No zone named "${name}" on the floor.` }, 404);
      const inUse = usage[name] || 0;
      let moved = 0;
      let moveTo = null;
      if (inUse > 0) {
        moveTo = String(data.moveTo || '').trim();
        if (!moveTo) {
          return json(
            {
              ok: false,
              error: `${inUse} table${inUse === 1 ? ' sits' : 's sit'} in "${name}". Send "moveTo" with a surviving zone for them.`,
              tables: inUse,
            },
            400
          );
        }
        if (moveTo.toLowerCase() === name.toLowerCase()) {
          return json({ ok: false, error: 'moveTo names the zone being removed — pick a surviving zone.' }, 400);
        }
        if (findIdx(moveTo) === -1) {
          return json({ ok: false, error: `No zone named "${moveTo}" to move the tables into.` }, 404);
        }
        const { meta } = await d1Run(
          env,
          'UPDATE tables SET section = ? WHERE LOWER(TRIM(section)) = LOWER(?)',
          [moveTo, name]
        );
        moved = meta ? meta.changes : 0;
      }
      const beforeValue = JSON.stringify(work);
      const next = work.filter((s) => s.toLowerCase() !== name.toLowerCase());
      const listError = sectionsError(next);
      if (listError) return json({ ok: false, error: listError }, 400);
      await saveSections(env, auth, next, {
        beforeValue,
        moved,
        reason: `Zone "${name}" removed${moveTo ? ` — its ${moved} table${moved === 1 ? '' : 's'} moved to "${moveTo}"` : ' — no tables were in it'}`,
      });
      return json({ ok: true, sections: next, tablesMoved: moved });
    }

    if (data.action === 'reorder') {
      const orderError = sectionsError(data.sections);
      if (orderError) return json({ ok: false, error: orderError }, 400);
      const next = data.sections.map((s) => String(s).trim());
      const a = lower(next).sort().join('|');
      const b = lower(work).sort().join('|');
      if (a !== b) {
        return json(
          { ok: false, error: 'Reorder must send the same zones that exist today — add, rename or remove separately.' },
          400
        );
      }
      const beforeValue = JSON.stringify(work);
      await saveSections(env, auth, next, {
        beforeValue,
        reason: 'Zone order updated — pickers follow this order',
      });
      return json({ ok: true, sections: next });
    }

    return json({ ok: false, error: 'Unknown action — use rename, add, remove or reorder.' }, 400);
  }

  return null;
}

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
 * Put back tables that nobody cleared.
 *
 * Runs on the cron. Production had a table showing occupied four days after it
 * was seated: the floor plan had lost a table and no screen would ever say so,
 * because occupied is a state somebody has to leave and on a busy evening
 * nobody does.
 *
 * Three rules keep this from doing harm:
 *
 *  - The max is four hours (venue's decision — a cafe turns in under an hour).
 *    Past it, the table comes off the floor plan no matter what, because a
 *    table held for days is a lie the whole room is paying for. What happens
 *    next depends on the bill:
 *      - nothing owed -> 'available', exactly as before;
 *      - money owed   -> 'cleaning', so it is not instantly re-seated over an
 *        unsettled check, and a human has to look at it. The check itself is
 *        untouched and stays in Open Checks — the bill is never hidden, it
 *        just stops holding the table hostage. (The first version of this
 *        sweep skipped owed tables entirely, which is how a 300-hour-old
 *        unpaid TEA kept one table occupied for 114 hours straight.)
 *  - The owed match is done on normalised table references. orders.table_id
 *    holds "T-01", "Table 1" and "1" for the same table, and a plain string
 *    compare misses two of the three — which releases a table that still has
 *    a bill, or holds one that has none.
 *  - A table occupied with no seated_at is not aged, because there is nothing
 *    to age it from. It gets stamped instead, so it starts counting from when
 *    it was noticed rather than staying stuck forever. Production has one.
 */
async function releaseOverstayedTables(env, maxHours = DEFAULT_TABLE_MAX_HOURS, nowMs = Date.now()) {
  const nowIso = new Date(nowMs).toISOString();
  const released = [];
  const releasedOwing = [];
  const stamped = [];

  const { results: tables } = await d1Query(
    env,
    "SELECT id, number, status, seated_at, guests, server FROM tables WHERE LOWER(status) = 'occupied'"
  );
  if (!(tables || []).length) return { released, releasedOwing, stamped };

  // One read for every open bill's table reference, normalised in JS: D1 has
  // no cheap way to fold "T-01" and "1" together in SQL, and running the
  // lookup per table meant the spellings above never matched.
  const { results: owingRows } = await d1Query(
    env,
    `SELECT table_id FROM orders
      WHERE payment_status IN ('unpaid', 'partial')
        AND COALESCE(status, '') <> 'cancelled'
        AND table_id IS NOT NULL`
  );
  const owedTables = new Set(
    (owingRows || []).map((r) => normaliseTableId(r.table_id)).filter(Boolean)
  );

  for (const table of tables) {
    if (!String(table.seated_at || '').trim()) {
      await d1Run(env, 'UPDATE tables SET seated_at = ? WHERE id = ?', [nowIso, table.id]);
      stamped.push(table.number);
      continue;
    }
    if (!tableOverstayed(table, nowMs, maxHours)) continue;

    const owes = owedTables.has(normaliseTableId(table.number) || String(table.number));
    const nextStatus = owes ? 'cleaning' : 'available';

    // The party resets but the SECTION does not: `server` is what the
    // head-waiter scoping matches on, so the sweep must not scrub the name —
    // an abandoned table goes back to the same waiter's section, not to
    // nobody. Only a manager reassignment moves a table between sections.
    await d1Run(
      env,
      "UPDATE tables SET status = ?, seated_at = '', guests = 0 WHERE id = ?",
      [nextStatus, table.id]
    );
    (owes ? releasedOwing : released).push(table.number);

    await writeAudit(env, null, {
      action: 'update',
      entity: 'tables',
      entityId: table.id,
      before: { status: 'occupied', seated_at: table.seated_at },
      after: { status: nextStatus, released_by_sweep: true },
      reason: owes
        ? `Occupied for more than ${maxHours}h with a check still open — released to cleaning; the check remains in Open Checks`
        : `Occupied for more than ${maxHours}h with nothing owed — released automatically`,
    });
  }

  return { released, releasedOwing, stamped };
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

  // Zone reads/writes are their own sub-resource (/tables/sections) and must
  // be matched before the generic list/table routes below.
  const sectionsResult = await handleSections(pathname, method, request, env, auth);
  if (sectionsResult !== null) return sectionsResult;

  if (m === 'GET' && parts.length === 2) {
    const all = await listTablesWithHolds(env);
    // A waiter works their section, not the whole room: the floor plan a
    // head-waiter fetches shows only the tables a manager has assigned to
    // them by name. The manager keeps the full map - they are the one making
    // the assignments - and so does the cashier, who clears bills across
    // every section. The match is the staff member's own display name
    // (first + last), compared the way the assignment dropdown writes it.
    const role = String((auth && (auth.sessionRole || auth.role)) || '').toLowerCase();
    if (role === 'head-waiter') {
      const me = actorName(auth).trim().toLowerCase();
      if (!me) return json([]);
      return json(all.filter((t) => String(t.server || '').trim().toLowerCase() === me));
    }
    return json(all);
  }

  // Creating a table is a floor edit any `tables` writer may do, but creating
  // one that already names a server is an assignment - and assignments are a
  // manager's decision. The POS adds tables with no server, so this only ever
  // bites a direct API caller trying to sneak an assignment in through CREATE.
  if (m === 'POST' && parts.length === 2 && !isManager(auth)) {
    let body;
    try {
      body = await readBody(request.clone());
    } catch {
      body = null;
    }
    if (body && String(body.server || '').trim()) {
      return json({ ok: false, error: 'Only a manager can assign a server to a table.' }, 403);
    }
    return null;
  }

  /**
   * GET /api/tables/qr — the cards to print, one per table.
   *
   * Manager-only, because the response contains every table's key and that is
   * the whole point of the feature. It is a read of secrets, so it is never
   * cached and never logged.
   *
   * Tables without a key are returned with `url: null` rather than omitted, so
   * a manager printing cards can see at a glance which tables still need one
   * instead of wondering why the list is short.
   */
  if (m === 'GET' && parts.length === 3 && parts[2] === 'qr') {
    if (!isManager(auth)) {
      return json({ ok: false, error: 'Manager access required' }, 403);
    }
    const origin = url.searchParams.get('origin') || 'https://fufutcoffee.com';
    const { results } = await d1Query(env, 'SELECT id, number, name, qr_key FROM tables ORDER BY CAST(number AS INTEGER)');
    return json({
      ok: true,
      tables: (results || []).map((t) => ({
        id: t.id,
        number: t.number,
        name: t.name || `Table ${t.number}`,
        hasKey: Boolean(t.qr_key),
        url: t.qr_key ? tableOrderUrl(origin, t) : null,
      })),
    });
  }

  /**
   * POST /api/tables/:id/qr — mint or replace one table's key.
   *
   * Replacing is the point as much as minting: if a card is photographed,
   * damaged or walks off, a manager regenerates that table and reprints one
   * card. Every other table keeps working, which is why the key is per-table
   * rather than one secret for the room.
   *
   * Audited, because rotating a key silently invalidates a printed card and
   * somebody will need to know when that happened.
   */
  if (m === 'POST' && parts.length === 4 && parts[3] === 'qr') {
    if (!isManager(auth)) {
      return json({ ok: false, error: 'Manager access required' }, 403);
    }
    const tableId = parts[2];
    const { results } = await d1Query(env, 'SELECT id, number, name, qr_key FROM tables WHERE id = ?', [tableId]);
    const table = results && results[0];
    if (!table) return json({ ok: false, error: 'Table not found' }, 404);

    const key = generateTableKey();
    await d1Run(env, 'UPDATE tables SET qr_key = ? WHERE id = ?', [key, tableId]);
    await writeAudit(env, auth, {
      action: table.qr_key ? 'update' : 'create',
      entity: 'tables',
      entityId: tableId,
      reason: table.qr_key ? 'QR code regenerated — the previous printed card no longer works' : 'QR code created',
    });

    const origin = url.searchParams.get('origin') || 'https://fufutcoffee.com';
    return json({
      ok: true,
      table: { id: table.id, number: table.number, name: table.name || `Table ${table.number}` },
      replaced: Boolean(table.qr_key),
      url: tableOrderUrl(origin, { ...table, qr_key: key }),
    });
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

    // ── Assignment gate ──────────────────────────────────────────────────────
    // Only a manager decides who owns a table. Status, guests and notes stay
    // with the floor staff who run service; the name on the table does not.
    // Two shapes of write are still allowed through for everyone, or normal
    // service would break:
    //   - an empty server, because the two "free the table" flows (Orders,
    //     Checkout) reset the whole party - status, guests, server, timer -
    //     and clearing a name is housekeeping, not assignment;
    //   - the stored name echoed back unchanged, because the seat/checkout
    //     flows PUT the row they fetched (a spread) and would otherwise 403
    //     on their own shadow.
    {
      const { results: curRows } = await d1Query(
        env,
        'SELECT id, number, server, section FROM tables WHERE id = ?',
        [tableId]
      );
      const current = (curRows || [])[0];
      if (!current) return null; // let the generic handler answer 404
      if (!isManager(auth) && data.server !== undefined) {
        const nextServer = String(data.server || '').trim().toLowerCase();
        const storedServer = String(current.server || '').trim().toLowerCase();
        if (nextServer && nextServer !== storedServer) {
          return json(
            { ok: false, error: 'Only a manager can assign a server to a table.' },
            403
          );
        }
      }
      // Moving a table between zones is floor layout, and floor layout is the
      // manager's call — same rule as the server assignment above. Service
      // flows never write `section`, so this only bites a direct API caller.
      if (!isManager(auth) && data.section !== undefined) {
        const nextZone = String(data.section || '').trim().toLowerCase();
        const storedZone = String(current.section || '').trim().toLowerCase();
        if (nextZone !== storedZone) {
          return json(
            { ok: false, error: 'Only a manager can move a table between zones.' },
            403
          );
        }
      }
    }

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

    if (claimingNewSeat && alreadyOccupied) {
      if (!isManager(auth)) {
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

      // Taking a table off the party already on it is a decision, not a
      // routine write, and the person displaced is not there to describe what
      // happened. `override: true` is carried so the entry cannot be diffed
      // away to nothing when the incoming guests and server happen to match
      // the ones being replaced.
      await writeAudit(env, auth, {
        action: 'override',
        entity: 'tables',
        entityId: table.id,
        before: {
          occupied_by: table.server || null,
          guests: table.guests || 0,
          seated_at: table.seated_at || null,
        },
        after: {
          occupied_by: data.server || null,
          guests: data.guests || 0,
          seated_at: data.seated_at || null,
          override: true,
        },
        reason: `Seated a new party on table ${table.number} over the one already there`,
      });
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

    // `released_by` on the booking says who, but only to whoever thinks to open
    // that row. A promise made to a guest and then taken back belongs in the
    // log the manager and the accountant actually read.
    await writeAudit(env, auth, {
      action: 'override',
      entity: 'reservations',
      entityId: hold.id,
      before: { status: hold.status, released_at: null },
      after: {
        status: 'cancelled',
        released_at: nowIso,
        released_by: actorName(auth),
        override: true,
      },
      reason: `Seated table ${table.number} over a booking held for ${hold.name || 'a guest'}`,
    });

    // A manager overriding is deliberate, so the claim is unconditional: they
    // have already been told what they are taking.
    return claimingNewSeat && !alreadyOccupied
      ? claimSeat(env, table, data, claimingNewSeat)
      : null;
  }

  return null;
}

export { handleTables, listTablesWithHolds, releaseOverstayedTables, SEATING_STATUSES };
