import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleResources } from '../src/handlers/resources.js';

/**
 * Finding 6 (B+ sim): paid-in / paid-out used to ride the audit log only, so
 * the drawer's `expected` figure was always `opening + cash_sales`. Any paid-in
 * surfaced as positive variance and any paid-out as negative variance at Z-
 * count, and the manager had to read the audit log to explain it. The columns
 * are now kept in sync at the paid-in/paid-out handlers and the close handler's
 * expected figure includes them: `opening + cash_sales + paid_in - paid_out`.
 */

function makeEnv({ drawer = null, overrides = {} } = {}) {
  const run = vi.fn().mockResolvedValue({ meta: { changes: 1 }, results: [] });
  const batch = vi.fn().mockResolvedValue([]);
  const boundParams = [];
  const prepare = vi.fn(function (sql) {
    return {
      bind: (...params) => {
        boundParams.push({ sql, params });
        return {
          all: async () => {
            for (const [frag, result] of Object.entries(overrides)) {
              if (sql.includes(frag)) return result;
            }
            if (/FROM cashdrawers WHERE/.test(sql)) {
              return {
                results: drawer ? [drawer] : [],
              };
            }
            return { results: [] };
          },
          run,
        };
      },
    };
  });
  const env = { DB: { prepare, batch } };
  return { env, run, batch, boundParams };
}

function makeRequest(pathname, method = 'GET', body = null) {
  const url = new URL('https://pos.fufutcoffee.com' + pathname);
  const req = new Request(url.toString(), {
    method,
    body: body ? JSON.stringify(body) : null,
    headers: { 'Content-Type': 'application/json' },
  });
  return { pathname, method, url, request: req };
}

const CASHIER = { staff_id: 'S3', sessionRole: 'cashier', firstName: 'Bethel' };

describe('Finding 6: paid-in/paid-out reach the expected formula', () => {
  afterEach(() => vi.restoreAllMocks());

  it('paid-in updates the drawer.paid_in column', async () => {
    const drawer = {
      id: 'CDopen01',
      opening_balance: 1000,
      cash_sales: 150,
      paid_in: 0,
      paid_out: 0,
      status: 'open',
    };
    const { env, boundParams } = makeEnv({ drawer });
    const ctx = makeRequest('/api/cashdrawer/paid-in', 'POST', {
      amount: 50,
      reason: 'change top-up',
    });
    const res = await handleResources(ctx.pathname, ctx.method, ctx.url, ctx.request, env, CASHIER);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    const upd = boundParams.find(
      (b) => /UPDATE cashdrawers\s+SET paid_in = COALESCE\(paid_in, 0\) \+ \?/.test(b.sql)
    );
    expect(upd, 'paid_in must be incremented').toBeTruthy();
    expect(upd.params).toEqual([50, 'CDopen01']);
  });

  it('paid-out updates the drawer.paid_out column', async () => {
    const drawer = {
      id: 'CDopen01',
      opening_balance: 1000,
      cash_sales: 150,
      paid_in: 50,
      paid_out: 0,
      status: 'open',
    };
    const { env, boundParams } = makeEnv({ drawer });
    const ctx = makeRequest('/api/cashdrawer/paid-out', 'POST', {
      amount: 25,
      reason: 'tea supply',
    });
    const res = await handleResources(ctx.pathname, ctx.method, ctx.url, ctx.request, env, CASHIER);
    expect(res.status).toBe(200);
    const upd = boundParams.find(
      (b) => /UPDATE cashdrawers\s+SET paid_out = COALESCE\(paid_out, 0\) \+ \?/.test(b.sql)
    );
    expect(upd, 'paid_out must be incremented').toBeTruthy();
    expect(upd.params).toEqual([25, 'CDopen01']);
  });

  it('close computes expected = opening + cash_sales + paid_in - paid_out', async () => {
    const drawer = {
      id: 'CDopen01',
      opening_balance: 1000,
      cash_sales: 1570,
      paid_in: 50,
      paid_out: 25,
      status: 'open',
    };
    const { env } = makeEnv({ drawer });
    const ctx = makeRequest('/api/cashdrawer/close', 'POST', {
      id: 'CDopen01',
      closingBal: 2595, // exactly matches expected; variance 0
    });
    const res = await handleResources(ctx.pathname, ctx.method, ctx.url, ctx.request, env, CASHIER);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.expected).toBe(2595); // 1000 + 1570 + 50 - 25
    expect(body.variance).toBe(0);
    expect(body.paidIn).toBe(50);
    expect(body.paidOut).toBe(25);
  });

  it('close tolerates NULL paid_in/paid_out (pre-migration drawers)', async () => {
    const drawer = {
      id: 'CDold01',
      opening_balance: 1000,
      cash_sales: 130,
      paid_in: null, // migration 020 not yet applied
      paid_out: null,
      status: 'open',
    };
    const { env } = makeEnv({ drawer });
    const ctx = makeRequest('/api/cashdrawer/close', 'POST', {
      id: 'CDold01',
      closingBal: 1130,
    });
    const res = await handleResources(ctx.pathname, ctx.method, ctx.url, ctx.request, env, CASHIER);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.expected).toBe(1130); // 1000 + 130 + 0 - 0
    expect(body.paidIn).toBe(0);
    expect(body.paidOut).toBe(0);
  });

  it('paid-in surfaces variance correctly when the count matches the new formula', async () => {
    // Float 1000, cash_sales 200, paid_in 50 → expected 1250. Cashier counts 1250
    // exactly; without this fix the system would have reported variance -50.
    const drawer = {
      id: 'CDopen02',
      opening_balance: 1000,
      cash_sales: 200,
      paid_in: 50,
      paid_out: 0,
      status: 'open',
    };
    const { env } = makeEnv({ drawer });
    const ctx = makeRequest('/api/cashdrawer/close', 'POST', {
      id: 'CDopen02',
      closingBal: 1250,
    });
    const res = await handleResources(ctx.pathname, ctx.method, ctx.url, ctx.request, env, CASHIER);
    const body = await res.json();
    expect(body.expected).toBe(1250);
    expect(body.variance).toBe(0);
  });
});
