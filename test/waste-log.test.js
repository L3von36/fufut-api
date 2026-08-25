import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleWaste } from '../src/handlers/inventory.js';

/**
 * Free-text waste (no inventory link) used to fall through to the generic
 * resource handler, which dropped the item name (no column), the quantity
 * (form field `quantity`, column `qty`) and the cost. The log filled with rows
 * carrying a reason and nothing else, and the screen rendered a blank item at
 * ETB 0. These tests pin the fields the entry must actually carry.
 *
 * The D1 fake records every bound statement so tests can assert on the values
 * handed to the INSERT, mirroring orders-open-tabs.test.js.
 */
function makeEnv() {
  const bound = [];
  const prepare = vi.fn(function (sql) {
    return {
      bind: (...params) => {
        bound.push({ sql, params });
        return {
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 1 }, results: [] }),
        };
      },
    };
  });
  return {
    env: { DB: { prepare, batch: vi.fn().mockResolvedValue([]) } },
    bound,
  };
}

function makeRequest(body) {
  const req = new Request('https://pos.fufutcoffee.com/api/waste', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
  return req;
}

const AUTH = { staff_id: 'S2', firstName: 'Selam', lastName: 'Wondimu' };

describe('POST /api/waste (free-text entry)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('records the name, quantity, cost and category the form collects', async () => {
    const { env, bound } = makeEnv();
    const res = await handleWaste(
      '/api/waste', 'POST', makeRequest({ name: 'Spoiled milk', category: 'Dairy', quantity: 1, reason: 'spoiled', cost: 25 }),
      env, AUTH
    );
    expect(res.status).toBe(200);
    const parsed = await res.json();
    expect(parsed.ok).toBe(true);
    expect(parsed.untracked).toBe(true);

    const insert = bound.find((b) => /INSERT INTO waste/.test(b.sql));
    expect(insert).toBeTruthy();
    // Column order: id, item_id(NULL is literal SQL), name, category, qty,
    // reason, est_cost, logged_by, date, created — nine bound params.
    expect(insert.params[1]).toBe('Spoiled milk');
    expect(insert.params[2]).toBe('Dairy');
    expect(insert.params[3]).toBe(1);
    expect(insert.params[4]).toBe('spoiled');
    expect(insert.params[5]).toBe(25);
    expect(insert.params[6]).toBe('Selam Wondimu');
  });

  it('accepts the tracked-waste field names too', async () => {
    const { env, bound } = makeEnv();
    const res = await handleWaste(
      '/api/waste', 'POST', makeRequest({ name: 'Cracked eggs', qty: 3, est_cost: 45, reason: 'damaged' }),
      env, AUTH
    );
    expect(res.status).toBe(200);
    const insert = bound.find((b) => /INSERT INTO waste/.test(b.sql));
    expect(insert.params[3]).toBe(3);
    expect(insert.params[5]).toBe(45);
  });

  it('refuses an entry with no item name', async () => {
    const { env } = makeEnv();
    const res = await handleWaste(
      '/api/waste', 'POST', makeRequest({ quantity: 1, reason: 'spoiled', cost: 25 }),
      env, AUTH
    );
    expect(res.status).toBe(400);
  });

  it('refuses an entry with no reason, like tracked waste', async () => {
    const { env } = makeEnv();
    const res = await handleWaste(
      '/api/waste', 'POST', makeRequest({ name: 'Spoiled milk', quantity: 1, cost: 25 }),
      env, AUTH
    );
    expect(res.status).toBe(400);
    const parsed = await res.json();
    expect(parsed.error).toMatch(/reason/i);
  });

  it('routes an entry naming an inventory item to the stock-moving path', async () => {
    // The tracked path reads the inventory row first; the fake returns none,
    // so it 404s — which is exactly how we know it left the free-text path.
    // `quantity` (the form's name) must reach it, which is what failed before
    // the tracked path learned both field names.
    const { env, bound } = makeEnv();
    const res = await handleWaste(
      '/api/waste', 'POST', makeRequest({ inventoryId: 'I1', name: 'Milk', quantity: 2, reason: 'spoiled' }),
      env, AUTH
    );
    expect(res.status).toBe(404);
    expect(bound.find((b) => /INSERT INTO waste/.test(b.sql))).toBeFalsy();
  });

  it('refuses tracked waste with no parseable quantity under either name', async () => {
    const { env } = makeEnv();
    const res = await handleWaste(
      '/api/waste', 'POST', makeRequest({ inventoryId: 'I1', reason: 'spoiled' }),
      env, AUTH
    );
    expect(res.status).toBe(400);
    const parsed = await res.json();
    expect(parsed.error).toMatch(/greater than zero/i);
  });
});

describe('GET /api/waste (joined list)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns rows aliased for every screen that reads them', async () => {
    const rows = [{ id: 'W1', qty: 2, est_cost: 50, name: 'Spoiled milk', reason: 'spoiled' }];
    const prepare = vi.fn(function (sql) {
      return {
        bind: (...params) => ({
          all: async () => ({ results: rows }),
          run: async () => ({ meta: { changes: 1 } }),
        }),
      };
    });
    const env = { DB: { prepare, batch: vi.fn() } };
    const res = await handleWaste('/api/waste', 'GET', new Request('https://pos.fufutcoffee.com/api/waste'), env, AUTH);
    expect(res.status).toBe(200);
    const sql = prepare.mock.calls[0][0];
    // The join resolves a tracked entry's name from inventory; the aliases
    // carry the names the POS and backoffice templates actually read.
    expect(sql).toMatch(/LEFT JOIN inventory/i);
    expect(sql).toMatch(/AS quantity/i);
    expect(sql).toMatch(/AS cost/i);
    expect(sql).toMatch(/AS item/i);
  });
});
