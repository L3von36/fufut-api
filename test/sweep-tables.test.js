import { describe, it, expect, vi, afterEach } from 'vitest';
import { releaseOverstayedTables } from '../src/handlers/tables.js';

/**
 * The four-hour table sweep.
 *
 * Production held one table occupied for 114 hours behind a 300-hour-old unpaid
 * check: the first version of this sweep refused to release any table with
 * money owed, so a stale test check could hold the floor plan hostage forever.
 * The venue's rule is now explicit — four hours maximum, whatever is owed. The
 * check survives in Open Checks (a bill is never hidden), but it stops owning
 * the table.
 */

const H = 3600000;

function makeEnv({ tables = [], owedTableIds = [] } = {}) {
  const updates = [];
  const audits = [];
  const prepare = vi.fn(function (sql) {
    return {
      bind: (...params) => {
        if (/INSERT INTO audit_log/.test(sql)) {
          let after = params[9];
          try { after = JSON.parse(after); } catch { /* keep raw */ }
          audits.push({
            entityId: params[7],
            after,
            reason: params[10],
          });
        }
        return {
          all: async () => {
            if (/FROM tables WHERE LOWER\(status\) = 'occupied'/.test(sql)) {
              return { results: tables };
            }
            if (/SELECT table_id FROM orders/.test(sql)) {
              return { results: owedTableIds.map((t) => ({ table_id: t })) };
            }
            return { results: [] };
          },
          run: async () => {
            if (/UPDATE tables SET/.test(sql)) {
              updates.push({ sql, params });
            }
            return { meta: { changes: 1 } };
          },
        };
      },
    };
  });
  return { env: { DB: { prepare } }, updates, audits };
}

const now = Date.parse('2026-08-25T12:00:00.000Z');

function occupiedTable(number, seatedHoursAgo, id) {
  return {
    id: id || 'T' + String(number).padStart(2, '0'),
    number: String(number),
    status: 'occupied',
    seated_at: new Date(now - seatedHoursAgo * H).toISOString(),
    guests: 2,
    server: 'Yonas',
  };
}

describe('releaseOverstayedTables', () => {
  afterEach(() => vi.restoreAllMocks());

  it('releases a table held past the maximum with nothing owed, to available', async () => {
    const { env, updates, audits } = makeEnv({
      tables: [occupiedTable(4, 5)], // five hours — one past the line
    });

    const res = await releaseOverstayedTables(env, 4, now);

    expect(res.released).toEqual(['4']);
    expect(res.releasedOwing).toEqual([]);
    expect(updates).toHaveLength(1);
    expect(updates[0].params).toEqual(['available', 'T04']);
    expect(audits).toHaveLength(1);
    expect(audits[0].after).toMatchObject({ status: 'available' });
  });

  it('releases a table with an open check too — to cleaning, not available', async () => {
    // The 114-hour table: occupied far past the maximum, with an unpaid check
    // filed against it. Before this change it was skipped outright.
    const { env, updates, audits } = makeEnv({
      tables: [occupiedTable(1, 114)],
      owedTableIds: ['1'],
    });

    const res = await releaseOverstayedTables(env, 4, now);

    expect(res.released).toEqual([]);
    expect(res.releasedOwing).toEqual(['1']);
    expect(updates[0].params).toEqual(['cleaning', 'T01']);
    expect(audits[0].after).toMatchObject({ status: 'cleaning' });
    expect(audits[0].reason).toMatch(/check remains in Open Checks/);
  });

  it('matches the owed check across the spellings one table acquires', async () => {
    // orders.table_id has held "T-1", "Table 1" and "1" for the same table. A
    // plain string compare misses the prefixed forms, which would release a
    // table that still has a bill straight to available.
    const { env, updates } = makeEnv({
      tables: [occupiedTable(6, 6)],
      owedTableIds: ['Table 6'],
    });

    const res = await releaseOverstayedTables(env, 4, now);

    expect(res.releasedOwing).toEqual(['6']);
    expect(updates[0].params[0]).toBe('cleaning');
  });

  it('leaves a table alone inside the maximum, however much is owed', async () => {
    const { env, updates, audits } = makeEnv({
      tables: [occupiedTable(2, 3.9)],
      owedTableIds: ['2'],
    });

    const res = await releaseOverstayedTables(env, 4, now);

    expect(res.released).toEqual([]);
    expect(res.releasedOwing).toEqual([]);
    expect(updates).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it('stamps an occupied table with no seated_at instead of judging it', async () => {
    const mystery = { ...occupiedTable(7, 0), seated_at: '' };
    const { env, updates } = makeEnv({ tables: [mystery] });

    const res = await releaseOverstayedTables(env, 4, now);

    expect(res.stamped).toEqual(['7']);
    expect(res.released).toEqual([]);
    expect(updates).toHaveLength(1);
    expect(updates[0].params[1]).toBe('T07'); // SET seated_at = now WHERE id = ?
  });

  it('clears the sitting when it releases, so the timer stops — but keeps the section owner', async () => {
    const { env, updates } = makeEnv({
      tables: [occupiedTable(9, 8)],
    });

    await releaseOverstayedTables(env, 4, now);

    // status, seated_at, guests reset in one statement; `server` deliberately
    // survives: it is the table's section (head-waiter scoping matches on it),
    // not the departing party's runner.
    expect(updates[0].sql).toMatch(/seated_at = '', guests = 0 WHERE id = \?/);
    expect(updates[0].sql).not.toMatch(/server/);
  });
});
