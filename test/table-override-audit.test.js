import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleTables } from '../src/handlers/tables.js';

/**
 * Manager overrides on the floor, and whether they leave a trace.
 *
 * Two rules can be gone around here: a table already has a party on it, and a
 * table is held by a booking. Both refusals are correct and both have to be
 * escapable — somebody has to be able to decide. What must not happen is the
 * decision going unrecorded: the party displaced and the guest whose booking
 * was taken are the two people not in the room when it is questioned later.
 */
function makeEnv({ tableRow = null, reservationRows = [], claimChanges = 1 } = {}) {
  const audits = [];
  const run = vi.fn().mockResolvedValue({ meta: { changes: claimChanges }, results: [] });
  const boundParams = [];
  const prepare = vi.fn(function (sql) {
    return {
      bind: (...params) => {
        boundParams.push({ sql, params });
        if (/INSERT INTO audit_log/.test(sql)) {
          audits.push({
            action: params[5], entity: params[6], entityId: params[7],
            before: params[8], after: params[9], reason: params[10],
            actorName: params[3], actorRole: params[4],
          });
        }
        return {
          all: async () => {
            if (/FROM tables WHERE id/.test(sql)) return { results: tableRow ? [tableRow] : [] };
            if (/FROM reservations/.test(sql)) return { results: reservationRows };
            return { results: [] };
          },
          run,
        };
      },
    };
  });
  return { env: { DB: { prepare, batch: vi.fn().mockResolvedValue([]) } }, audits, run, boundParams };
}

function seatReq(tableId, body) {
  const pathname = `/api/tables/${tableId}`;
  const url = new URL('https://backoffice.fufutcoffee.com' + pathname);
  return {
    pathname,
    method: 'PUT',
    url,
    request: new Request(url.toString(), {
      method: 'PUT',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
  };
}

const WAITER = { staff_id: 'S1', sessionRole: 'head-waiter', firstName: 'Yonas' };
const MANAGER = { staff_id: 'S9', sessionRole: 'manager', firstName: 'Amanuel' };

const BUSY = { id: 'T003', number: '3', status: 'occupied', server: 'Yonas', guests: 4, seated_at: '2026-08-17T18:00:00.000Z' };
const FREE = { id: 'T004', number: '4', status: 'available', server: '', guests: 0, seated_at: '' };

async function call(ctx, env, auth) {
  return handleTables(ctx.pathname, ctx.method, ctx.url, ctx.request, env, auth);
}

describe('manager override is recorded', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs who was displaced when a manager takes an occupied table', async () => {
    const { env, audits } = makeEnv({ tableRow: BUSY });

    const res = await call(
      seatReq('T003', { status: 'occupied', newSeating: true, server: 'Bereket', guests: 2 }),
      env,
      MANAGER
    );

    // null means "fall through to the generic handler and do the write".
    expect(res).toBeNull();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'override', entity: 'tables', entityId: 'T003' });
    expect(audits[0].actorRole).toBe('manager');
    expect(JSON.parse(audits[0].before)).toMatchObject({ occupied_by: 'Yonas', guests: 4 });
    expect(audits[0].reason).toMatch(/table 3/i);
  });

  // The entry must survive diffing even when the replacement party looks
  // identical to the one being replaced.
  it('records the override even when nothing else about the seating changes', async () => {
    const { env, audits } = makeEnv({ tableRow: BUSY });

    await call(
      seatReq('T003', { status: 'occupied', newSeating: true, server: 'Yonas', guests: 4 }),
      env,
      MANAGER
    );

    expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0].after)).toMatchObject({ override: true });
  });

  it('writes nothing when a waiter is refused', async () => {
    const { env, audits } = makeEnv({ tableRow: BUSY });

    const res = await call(
      seatReq('T003', { status: 'occupied', newSeating: true }),
      env,
      WAITER
    );

    expect(res.status).toBe(409);
    expect(audits).toHaveLength(0);
  });

  it('writes nothing for an ordinary seating of a free table', async () => {
    const { env, audits } = makeEnv({ tableRow: FREE });

    await call(
      seatReq('T004', { status: 'occupied', newSeating: true, guests: 2 }),
      env,
      WAITER
    );

    expect(audits).toHaveLength(0);
  });

  it('logs the booking a manager seated over', async () => {
    const start = new Date(Date.now() + 10 * 60000).toISOString();
    const end = new Date(Date.now() + 100 * 60000).toISOString();
    const { env, audits } = makeEnv({
      tableRow: FREE,
      reservationRows: [
        { id: 'R1', name: 'Selam', guests: 2, status: 'confirmed', start_at: start, end_at: end, released_at: null, no_show_at: null },
      ],
    });

    const res = await call(seatReq('T004', { status: 'occupied', newSeating: true }), env, MANAGER);

    expect(res).toBeNull();
    const booking = audits.find((a) => a.entity === 'reservations');
    expect(booking).toBeTruthy();
    expect(booking).toMatchObject({ action: 'override', entityId: 'R1' });
    expect(booking.reason).toMatch(/Selam/);
    expect(JSON.parse(booking.after)).toMatchObject({ status: 'cancelled', override: true });
  });

  it('writes nothing when a waiter is refused a booked table', async () => {
    const start = new Date(Date.now() + 10 * 60000).toISOString();
    const end = new Date(Date.now() + 100 * 60000).toISOString();
    const { env, audits } = makeEnv({
      tableRow: FREE,
      reservationRows: [
        { id: 'R1', name: 'Selam', guests: 2, status: 'confirmed', start_at: start, end_at: end, released_at: null, no_show_at: null },
      ],
    });

    const res = await call(seatReq('T004', { status: 'occupied', newSeating: true }), env, WAITER);

    expect(res.status).toBe(409);
    expect(audits).toHaveLength(0);
  });
});
