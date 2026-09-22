import { describe, it, expect, vi } from 'vitest';
import { handleOrders } from '../src/handlers/orders.js';

/**
 * Day-window reads on GET /api/orders — the "orders show today, history shows
 * the rest" feature the whole product leans on (web OrdersView, the Flutter
 * Orders screen, the bot's /orders and /history, and the dashboard's
 * yesterday panel that was already sending from/to before the handler
 * understood them).
 *
 * The fake mirrors orders-open-tabs.test.js: D1 prepare() is recorded and
 * answered by SQL shape, so the assertions can pin the exact clause, the bound
 * day keys and the paging arithmetic.
 */
function makeEnv({ listRows = [] } = {}) {
  const bound = [];
  const prepare = vi.fn(function (sql) {
    return {
      bind: (...params) => {
        bound.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        return {
          all: async () => {
            if (/FROM orders/.test(sql)) return { results: listRows, meta: { rows_read: listRows.length } };
            return { results: [], meta: { rows_read: 0 } };
          },
          run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
        };
      },
    };
  });
  return { env: { DB: { prepare, batch: vi.fn().mockResolvedValue([]) } }, prepare, bound };
}

function makeRequest(pathWithQuery) {
  const url = new URL('https://pos.fufutcoffee.com' + pathWithQuery);
  // The real router hands the handler a bare pathname plus the parsed URL —
  // the query string travels in `url.searchParams`, never in `pathname`.
  const pathname = url.pathname;
  const req = new Request(url.toString(), { method: 'GET' });
  return { pathname, method: 'GET', url, request: req };
}

const TODAY_ROWS = [
  { id: 'Otoday01', items: '1xLatte', total: 130, status: 'served', created: '2026-09-21 09:15:00', table_id: '3' },
  { id: 'Otoday02', items: '2xTea', total: 90, status: 'new', created: '2026-09-21 11:40:00', table_id: null },
];

describe('GET /api/orders day windows', () => {
  it('keeps the default list on the untouched LIMIT 200 shape', async () => {
    const { env, bound } = makeEnv({ listRows: TODAY_ROWS });
    const res = await handleOrders(...Object.values(makeRequest('/api/orders')), env, { staff_id: 'S1' });
    expect(res.status).toBe(200);
    const rows = await res.json();
    expect(rows).toHaveLength(2);
    expect(rows[0].tableNum).toBe('3');
    const q = bound[0];
    expect(q.sql).toBe('SELECT * FROM orders ORDER BY created DESC LIMIT 200');
    expect(q.params).toEqual([]);
  });

  it('filters from+to through date(created) with bound day keys', async () => {
    const { env, bound } = makeEnv({ listRows: TODAY_ROWS });
    const res = await handleOrders(...Object.values(makeRequest('/api/orders?from=2026-09-21&to=2026-09-21')), env, { staff_id: 'S1' });
    expect(res.status).toBe(200);
    const rows = await res.json();
    expect(rows.map((r) => r.id)).toEqual(['Otoday01', 'Otoday02']);

    const q = bound.find((b) => /date\(created\)/.test(b.sql));
    expect(q).toBeTruthy();
    expect(q.sql).toContain('WHERE date(created) >= ? AND date(created) <= ?');
    expect(q.sql).toContain('ORDER BY created DESC LIMIT 200 OFFSET 0');
    expect(q.params).toEqual(['2026-09-21', '2026-09-21']);
  });

  it('accepts a from-only window (everything up to and including that day is cut below)', async () => {
    const { env, bound } = makeEnv({ listRows: TODAY_ROWS });
    await handleOrders(...Object.values(makeRequest('/api/orders?from=2026-09-15')), env, { staff_id: 'S1' });
    const q = bound.find((b) => /date\(created\)/.test(b.sql));
    expect(q.sql).toContain('WHERE date(created) >= ?');
    expect(q.sql).not.toContain('date(created) <= ?');
    expect(q.params).toEqual(['2026-09-15']);
  });

  it('honours limit/offset for the history pagers and clamps extremes', async () => {
    const { env, bound } = makeEnv({ listRows: [] });
    await handleOrders(...Object.values(makeRequest('/api/orders?from=2026-09-01&to=2026-09-20&limit=100&offset=100')), env, { staff_id: 'S1' });
    const q = bound.find((b) => /date\(created\)/.test(b.sql));
    expect(q.sql).toContain('LIMIT 100 OFFSET 100');

    // A silly limit (9999) is clamped into the 1..500 guard, a negative
    // offset snaps back to 0 — both never reach SQL as garbage.
    await handleOrders(...Object.values(makeRequest('/api/orders?from=2026-09-01&limit=9999&offset=-5')), env, { staff_id: 'S1' });
    const q2 = bound.filter((b) => /date\(created\)/.test(b.sql)).pop();
    expect(q2.sql).toContain('LIMIT 500 OFFSET 0');
  });

  it('ignores malformed day keys and falls back to the default list', async () => {
    const { env, bound } = makeEnv({ listRows: TODAY_ROWS });
    const res = await handleOrders(...Object.values(makeRequest('/api/orders?from=drop%20table;--&to=2026-13-99')), env, { staff_id: 'S1' });
    expect(res.status).toBe(200);
    const rows = await res.json();
    expect(rows).toHaveLength(2);
    expect(bound.some((b) => /date\(created\)/.test(b.sql))).toBe(false);
  });

  it('narrow open checks (open=1) to the window in JS by created prefix', async () => {
    const openRows = [
      { id: 'Oold01', status: 'served', payment_status: 'unpaid', created: '2026-09-19 18:00:00' },
      { id: 'Otoday01', status: 'served', payment_status: 'unpaid', created: '2026-09-21 10:00:00' },
    ];
    const { env } = makeEnv({ listRows: openRows });
    const res = await handleOrders(...Object.values(makeRequest('/api/orders?open=1&from=2026-09-21&to=2026-09-21')), env, { staff_id: 'S1' });
    const rows = await res.json();
    expect(rows.map((r) => r.id)).toEqual(['Otoday01']);
  });

  it('narrow per-table reads to the window as well (tables with an older tab)', async () => {
    const tableRows = [
      { id: 'Oold02', table_id: '5', status: 'served', payment_status: 'unpaid', created: '2026-09-18 19:30:00' },
      { id: 'Otoday03', table_id: '5', status: 'new', payment_status: 'unpaid', created: '2026-09-21 12:05:00' },
    ];
    const { env } = makeEnv({ listRows: tableRows });
    const res = await handleOrders(...Object.values(makeRequest('/api/orders?table_number=5&from=2026-09-21&to=2026-09-21')), env, { staff_id: 'S1' });
    const rows = await res.json();
    expect(rows.map((r) => r.id)).toEqual(['Otoday03']);
  });
});
