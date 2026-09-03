import { describe, it, expect, vi } from 'vitest';
import { handleInventory } from '../src/handlers/inventory.js';

/**
 * GET /api/inventory/snapshot — the shelf as it stood at the end of a day.
 *
 * The ledger carries the running balance on every row, so the closing figure
 * for a day is a lookup: the last movement inside the day. What the tests
 * actually protect:
 *
 *   - a sale/purchase/waste on the FOLLOWING day must not move the previous
 *     day's figure (the day-boundary bug is the whole reason this endpoint
 *     could not just be "current stock minus something");
 *   - items whose ledger history starts AFTER the day are estimated backwards
 *     from today's stock and say so (`basis: 'estimate'`) instead of passing
 *     a invented number off as recorded;
 *   - two movements sharing one timestamp resolve to the last one inserted,
 *     which is the balance the ledger really ended on;
 *   - the day columns answer "what arrived, what sold, what was thrown out";
 *   - a role whose inventory access came from a Role Access grant is refused
 *     the same way it is refused variance and the other stock reports;
 *   - a malformed date is a 400, not an empty grid.
 *
 * D1 fake keyed on the shape of the SQL, matching role-scopes.test.js.
 */

const INV = [
  { id: 'I1', name: 'Coffee beans', unit: 'kg', category: 'Coffee & Tea', stock: 7 },
  { id: 'I2', name: 'Milk', unit: 'l', category: 'Dairy', stock: 8 },
  { id: 'I3', name: 'Takeaway cup', unit: 'piece', category: 'Packaging', stock: 5 },
];

// The ledger as the cafe would have written it: Addis-local stamps through
// the 1st–2nd, an ISO-UTC stamp on the later sale (both shapes exist in the
// live table), quantities signed — consumption negative, purchases positive.
const MOVES = [
  { inventory_id: 'I1', at: '2026-09-01 09:00:00', qty: 10, type: 'purchase', balance_after: 12 },
  { inventory_id: 'I1', at: '2026-09-01 12:00:00', qty: -2, type: 'sale', balance_after: 10 },
  { inventory_id: 'I1', at: '2026-09-02T08:00:00.000Z', qty: -1, type: 'sale', balance_after: 9 },
  { inventory_id: 'I1', at: '2026-09-02 10:00:00', qty: -2, type: 'waste', balance_after: 7 },
  { inventory_id: 'I2', at: '2026-09-03 09:00:00', qty: -3, type: 'sale', balance_after: 8 },
];

function makeEnv({ inventoryRows = [], movementRows = [], settings = {} } = {}) {
  const settingsMap = new Map(Object.entries(settings));
  return {
    DB: {
      prepare: vi.fn((sql) => ({
        bind: (...params) => ({
          all: async () => ({ results: answer(sql, params, { inventoryRows, movementRows, settingsMap }) }),
          run: async () => ({ meta: { changes: 0 }, results: [] }),
          first: async () => null,
        }),
      })),
    },
  };
}

function answer(sql, params, fx) {
  if (/FROM settings WHERE key = \?/.test(sql)) {
    const key = String(params[0]);
    return fx.settingsMap.has(key) ? [{ value: fx.settingsMap.get(key) }] : [];
  }
  if (/MAX\(at\) AS mat/.test(sql)) {
    const byItem = new Map();
    for (const m of fx.movementRows) {
      if (m.at < params[0] && m.balance_after != null) {
        const cur = byItem.get(m.inventory_id);
        if (!cur || m.at > cur) byItem.set(m.inventory_id, m.at);
      }
    }
    return [...byItem].map(([inventory_id, mat]) => ({ inventory_id, mat }));
  }
  if (/ORDER BY rowid ASC/.test(sql)) {
    return fx.movementRows
      .map((m, i) => ({ ...m, rowid: i + 1 }))
      .filter((m) => m.at >= params[0] && m.at < params[1] && m.balance_after != null)
      .sort((a, b) => a.rowid - b.rowid);
  }
  if (/SUM\(qty\) AS net/.test(sql)) {
    const byItem = new Map();
    for (const m of fx.movementRows) {
      if (m.at >= params[0]) byItem.set(m.inventory_id, (byItem.get(m.inventory_id) || 0) + m.qty);
    }
    return [...byItem].map(([inventory_id, net]) => ({ inventory_id, net }));
  }
  if (/type = 'purchase'/.test(sql)) {
    const byItem = new Map();
    for (const m of fx.movementRows) {
      if (m.at < params[0] || m.at >= params[1]) continue;
      const acc =
        byItem.get(m.inventory_id) ||
        { inventory_id: m.inventory_id, purchased: 0, sold: 0, wasted: 0, adjusted: 0 };
      if (m.type === 'purchase') acc.purchased += m.qty;
      else if (m.type === 'sale') acc.sold += m.qty;
      else if (m.type === 'waste') acc.wasted += m.qty;
      else acc.adjusted += m.qty;
      byItem.set(m.inventory_id, acc);
    }
    return [...byItem.values()];
  }
  if (/SELECT id, name, unit, category, stock FROM inventory/.test(sql)) {
    return fx.inventoryRows;
  }
  return [];
}

function snapshotUrl(date) {
  return new URL(`http://localhost/api/inventory/snapshot?date=${date}`);
}

async function body(env, auth = { role: 'manager' }, date = '2026-09-01') {
  const res = await handleInventory('/api/inventory/snapshot', 'GET', snapshotUrl(date), null, env, auth);
  return { status: res.status, json: await res.json() };
}

describe('inventory snapshot', () => {
  it('closes the day on the ledger balance, not on the next day\u2019s movements', async () => {
    const { status, json } = await body(makeEnv({ inventoryRows: INV, movementRows: MOVES }));
    expect(status).toBe(200);
    const beans = json.items.find((i) => i.inventoryId === 'I1');
    expect(beans.basis).toBe('ledger');
    // 10 kg arrived, 2 kg sold on the 1st -> 12 -> 10. The sale and the waste
    // on the 2nd (one of them ISO-stamped) must not touch this figure.
    expect(beans.stockAtDate).toBe(10);
    expect(beans.stockNow).toBe(7);
    expect(beans.day.purchased).toBe(10);
    expect(beans.day.sold).toBe(2);
    expect(beans.day.wasted).toBe(0);
  });

  it('estimates backwards for items whose ledger starts after the day', async () => {
    const { json } = await body(makeEnv({ inventoryRows: INV, movementRows: MOVES }));
    const milk = json.items.find((i) => i.inventoryId === 'I2');
    expect(milk.basis).toBe('estimate');
    // Today holds 8 l; 3 l left on the 3rd, so the 1st closed on 11 l.
    expect(milk.stockAtDate).toBe(11);
    const cups = json.items.find((i) => i.inventoryId === 'I3');
    expect(cups.basis).toBe('estimate');
    expect(cups.stockAtDate).toBe(5);
  });

  it('resolves same-timestamp movements to the last one inserted', async () => {
    const rows = [
      { inventory_id: 'I1', at: '2026-09-01 15:00:00', qty: -1, type: 'sale', balance_after: 5 },
      { inventory_id: 'I1', at: '2026-09-01 15:00:00', qty: -2, type: 'sale', balance_after: 3 },
    ];
    const { json } = await body(makeEnv({ inventoryRows: [INV[0]], movementRows: rows }));
    expect(json.items[0].stockAtDate).toBe(3);
  });

  it('refuses a grant-scoped role the way it refuses the other stock reports', async () => {
    const env = makeEnv({
      inventoryRows: INV,
      movementRows: MOVES,
      settings: {
        'roleScope.barista': JSON.stringify({
          inventory: { enabled: true, categories: ['Coffee & Tea'], itemIds: [] },
        }),
      },
    });
    const { status } = await body(env, { role: 'barista' });
    expect(status).toBe(403);
  });

  it('answers a malformed date with a 400', async () => {
    const { status } = await body(makeEnv({ inventoryRows: INV }), { role: 'manager' }, 'not-a-date');
    expect(status).toBe(400);
  });

  it('brackets the day by date prefix so both timestamp shapes sort correctly', async () => {
    // A movement stamped exactly at the ISO boundary of the NEXT day must not
    // leak into the selected day's summary.
    const rows = [
      { inventory_id: 'I1', at: '2026-09-01 09:00:00', qty: 10, type: 'purchase', balance_after: 12 },
      { inventory_id: 'I1', at: '2026-09-02T00:00:00.000Z', qty: -4, type: 'sale', balance_after: 8 },
    ];
    const { json } = await body(makeEnv({ inventoryRows: [INV[0]], movementRows: rows }));
    const beans = json.items.find((i) => i.inventoryId === 'I1');
    expect(beans.day.purchased).toBe(10);
    expect(beans.day.sold).toBe(0);
    expect(beans.stockAtDate).toBe(12);
  });
});
