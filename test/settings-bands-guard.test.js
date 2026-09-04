import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { handleHR, incomeBandError } from '../src/handlers/hr.js';

/**
 * The guard on the settings door for tax bands.
 *
 * Editing `tax.income_bands` without a developer is the design: the bands are
 * data (§46), migration 025 even documents the runtime route as the way to
 * change them. The risk that comes with that design is a hand-typed table
 * that stores fine and then computes wrong — the engine treats a missing rate
 * as zero, so a `upto`-for-`upTo` typo or a `15` where `0.15` was meant would
 * not error anywhere. It would just mispay everybody, silently.
 *
 * So the API now refuses a malformed table with a message the manager can act
 * on, and any rate edit flips `payroll._unverified` back on: figures computed
 * from unconfirmed rates must never look authoritative. These tests pin both.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.join(HERE, '..', 'migrations', '025-income-tax-amendment-2025.sql');

/** The table currently in production, straight out of the migration of record. */
const AMENDED = (() => {
  const sql = readFileSync(MIGRATION, 'utf8');
  const m = sql.match(/SET value = '(\[.*?\])'/s);
  expect(m, 'migration 025 must still carry the band table as a JSON literal').toBeTruthy();
  return m[1];
})();

function makeEnv({ existingRow = null } = {}) {
  const run = vi.fn().mockResolvedValue({ meta: { changes: 1 }, results: [] });
  const boundParams = [];
  const prepare = vi.fn(function (sql) {
    const exec = (params) => ({
      all: async () => {
        if (/FROM settings/.test(sql)) {
          return { results: existingRow ? [existingRow] : [] };
        }
        return { results: [] };
      },
      run,
    });
    return {
      bind: (...params) => {
        boundParams.push({ sql, params });
        return exec(params);
      },
      all: async () => exec([]).all(),
      run,
    };
  });
  return { env: { DB: { prepare, batch: vi.fn().mockResolvedValue([]) } }, run, boundParams };
}

function req(pathname, method, body) {
  const url = new URL('https://backoffice.fufutcoffee.com' + pathname);
  return {
    pathname,
    method,
    url,
    request: new Request(url.toString(), {
      method,
      body: body === undefined ? null : JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
  };
}

const MANAGER = { staff_id: 'S9', sessionRole: 'manager' };
const WAITER = { staff_id: 'S1', sessionRole: 'head-waiter' };

async function putBands(env, auth, value) {
  return handleHR(
    '/api/settings/tax.income_bands', 'PUT',
    new URL('https://backoffice.fufutcoffee.com/api/settings/tax.income_bands'),
    req('/api/settings/tax.income_bands', 'PUT', { value }).request,
    env, auth
  );
}

afterEach(() => vi.restoreAllMocks());

describe('PUT /api/settings/tax.income_bands — the self-service guard', () => {
  it('accepts the amended table exactly as migration 025 stores it', async () => {
    const { env, boundParams } = makeEnv({ existingRow: { key: 'tax.income_bands', value: '[{}]' } });

    const res = await putBands(env, MANAGER, AMENDED);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    const update = boundParams.find((b) => /UPDATE settings SET value/.test(b.sql) && !/_unverified/.test(b.sql));
    expect(update).toBeTruthy();
    expect(update.params[0]).toBe(AMENDED);
  });

  it('refuses a misspelled key (`upto` for `upTo`) with a message that names it', async () => {
    const { env } = makeEnv();
    const res = await putBands(env, MANAGER, '[{"upto":2000,"rate":0,"deduct":0},{"upto":null,"rate":0.35,"deduct":2050}]');
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/upTo/);
    expect(body.error).toMatch(/upto/);
  });

  // The engine reads rate × pay − deduct. A percent written whole would tax
  // 15× the wage, which no error message could undo after the run.
  it('refuses a whole-number percent and points at the decimal form', async () => {
    const { env } = makeEnv();
    const res = await putBands(env, MANAGER, '[{"upTo":2000,"rate":0,"deduct":0},{"upTo":null,"rate":15,"deduct":2050}]');
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/0\.15/);
  });

  it('refuses a band missing its rate — the engine would read it as 0% tax', async () => {
    const { env } = makeEnv();
    const res = await putBands(env, MANAGER, '[{"upTo":2000,"deduct":0},{"upTo":null,"rate":0.35,"deduct":2050}]');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/rate/i);
  });

  it('refuses a null ceiling anywhere but the last band', async () => {
    const { env } = makeEnv();
    const res = await putBands(env, MANAGER,
      '[{"upTo":null,"rate":0,"deduct":0},{"upTo":4000,"rate":0.15,"deduct":300}]');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/last band/i);
  });

  it('refuses bands that are not ascending', async () => {
    const { env } = makeEnv();
    const res = await putBands(env, MANAGER,
      '[{"upTo":4000,"rate":0,"deduct":0},{"upTo":2000,"rate":0.15,"deduct":300},{"upTo":null,"rate":0.35,"deduct":2050}]');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/greater than the previous|upper limit/i);
  });

  it('refuses a negative deduct and broken JSON', async () => {
    const { env } = makeEnv();
    const badDeduct = await putBands(env, MANAGER,
      '[{"upTo":2000,"rate":0,"deduct":-5},{"upTo":null,"rate":0.35,"deduct":2050}]');
    expect(badDeduct.status).toBe(400);

    const { env: env2 } = makeEnv();
    const broken = await putBands(env2, MANAGER, '[{not json');
    expect(broken.status).toBe(400);
    expect((await broken.json()).error).toMatch(/valid JSON/i);
  });

  // The manager's own screen says "not valid JSON" first; this is the same
  // check where a stale tab or a direct API call would meet it.
  it('leaves every other setting unguarded — monthly hours is not a band table', async () => {
    const { env, boundParams } = makeEnv({ existingRow: { key: 'payroll.monthly_hours', value: '208' } });

    const url = new URL('https://backoffice.fufutcoffee.com/api/settings/payroll.monthly_hours');
    const res = await handleHR(
      '/api/settings/payroll.monthly_hours', 'PUT', url,
      new Request(url.toString(), {
        method: 'PUT', body: JSON.stringify({ value: '200' }), headers: { 'Content-Type': 'application/json' },
      }),
      env, MANAGER
    );

    expect(res.status).toBe(200);
    expect(boundParams.some((b) => /UPDATE settings SET value/.test(b.sql) && b.params[0] === '200')).toBe(true);
  });
});

describe('editing a rate re-opens the confirmation flag', () => {
  it('flips payroll._unverified to true when the bands change', async () => {
    const { env, boundParams } = makeEnv({
      existingRow: {
        key: 'payroll._unverified', value: 'false', category: 'payroll', label: 'Rates not yet confirmed',
      },
    });

    await putBands(env, MANAGER, AMENDED);

    const flip = boundParams.find((b) => /payroll\._unverified/.test(b.sql));
    expect(flip, 'the unverified row must be updated').toBeTruthy();
    // The 'true' is a literal in the SQL, not a bound parameter; the params
    // are the timestamp and the actor.
    expect(flip.sql).toContain("SET value = 'true'");
  });

  it('does not flip it for a setting that is not a rate', async () => {
    const { env, boundParams } = makeEnv({
      existingRow: { key: 'service.charge_pct', value: '0' },
    });

    const url = new URL('https://backoffice.fufutcoffee.com/api/settings/service.charge_pct');
    await handleHR(
      '/api/settings/service.charge_pct', 'PUT', url,
      new Request(url.toString(), {
        method: 'PUT', body: JSON.stringify({ value: '10' }), headers: { 'Content-Type': 'application/json' },
      }),
      env, MANAGER
    );

    expect(boundParams.some((b) => /payroll\._unverified/.test(b.sql))).toBe(false);
  });
});

describe('who may edit the bands at all', () => {
  // The same rule that governs running payroll: the person answerable for it.
  it('still refuses a non-manager before the guard is even reached', async () => {
    const { env } = makeEnv();
    const res = await putBands(env, WAITER, AMENDED);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/only a manager/i);
  });
});

describe('incomeBandError — message quality, unit-level', () => {
  it('passes the amended production table untouched', () => {
    expect(incomeBandError(AMENDED)).toBeNull();
  });

  it('accepts a single flat top band (a legal schedule could be one line)', () => {
    expect(incomeBandError('[{"upTo":null,"rate":0.35,"deduct":0}]')).toBeNull();
  });

  it('rejects an empty table rather than letting payroll compute 0 tax on nothing', () => {
    expect(incomeBandError('[]')).toMatch(/non-empty/i);
  });
});
