import { describe, it, expect, vi } from 'vitest';
import { handleTables, sectionsError } from '../src/handlers/tables.js';
import { handleHR } from '../src/handlers/hr.js';
import { handleResources } from '../src/handlers/resources.js';

/**
 * Floor zones as data.
 *
 * The zone list used to be a hardcoded array in the POS: renaming "Patio" or
 * adding a "Terrace" meant a developer and a deploy. It is one settings row
 * now, edited by the manager — and the moment a list is editable by hand it
 * needs the same guards the tax bands got:
 *
 *   - structural validation at the door (sectionsError),
 *   - renames and removals that carry the tables along (a zone renamed out
 *     from under six tables would strand them in a picker that no longer
 *     offers it),
 *   - a cap of nine zones (Miller's 7±2 — this list is scanned dozens of
 *     times a shift on a phone; it stops being a tool past that),
 *   - an audit entry that says what changed and how many tables moved.
 */

const MANAGER = { staff_id: 'S9', sessionRole: 'manager' };
const WAITER = { staff_id: 'S1', sessionRole: 'head-waiter' };

const API = 'https://backoffice.fufutcoffee.com';

/**
 * A fake D1 wired for exactly the statements the zone endpoints run.
 * Routing is by SQL shape, the way the real statements are distinguishable:
 *   settings read           → the stored row (or none)
 *   tables usage read       → configured per-zone counts
 *   UPDATE tables           → configured cascade count
 *   settings/audit writes   → captured, sql + params, in order
 */
function makeEnv({
  stored = null,          // JSON string in the settings row, or null
  usage = [],             // [{ section, n }]
  cascadeChanges = 0,     // what UPDATE tables reports
} = {}) {
  const state = { settingsValue: stored };
  const runs = [];

  const prepare = vi.fn((sql) => ({
    bind: (...params) => ({
      all: async () => {
        if (/FROM settings/i.test(sql)) {
          return { results: state.settingsValue == null ? [] : [{ value: state.settingsValue }] };
        }
        if (/FROM tables/i.test(sql) && /GROUP BY/i.test(sql)) {
          return { results: usage };
        }
        return { results: [] };
      },
      run: async () => {
        runs.push({ sql, params });
        if (/UPDATE tables/i.test(sql)) return { meta: { changes: cascadeChanges } };
        if (/INSERT INTO settings/i.test(sql)) {
          state.settingsValue = params[1];
          return { meta: { changes: 1 } };
        }
        if (/UPDATE settings/i.test(sql)) {
          state.settingsValue = params[0];
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 1 } };
      },
    }),
    all: async () => {
      if (/FROM settings/i.test(sql)) {
        return { results: state.settingsValue == null ? [] : [{ value: state.settingsValue }] };
      }
      if (/FROM tables/i.test(sql) && /GROUP BY/i.test(sql)) {
        return { results: usage };
      }
      return { results: [] };
    },
    run: async () => ({ meta: { changes: 1 } }),
  }));

  return { env: { DB: { prepare } }, runs, state };
}

function call(method, path, { body, auth = MANAGER } = {}) {
  const url = new URL(API + path);
  const request = new Request(url, {
    method,
    body: body === undefined ? null : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
  return handleTables(path, method, url, request, makeEnv().env, auth).then((res) =>
    res === null ? null : res
  );
}

/** handleTables with a shared env so assertions can read the captured writes. */
function withEnv(envBundle, method, path, body, auth = MANAGER) {
  const url = new URL(API + path);
  const request = new Request(url, {
    method,
    body: body === undefined ? null : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
  return handleTables(path, method, url, request, envBundle.env, auth);
}

async function json(res) {
  expect(res).toBeTruthy();
  return { status: res.status, body: await res.json() };
}

describe('sectionsError — the validator at the door', () => {
  it('accepts the five zones the floor ships with', () => {
    expect(sectionsError(['Patio', 'Main Hall', 'Window', 'VIP Room', 'Bar'])).toBeNull();
  });

  it('accepts the raw JSON string a settings write arrives as', () => {
    expect(sectionsError('["Patio","Bar"]')).toBeNull();
  });

  it('refuses nine-plus zones — Miller’s cap is a design rule, not a hint', () => {
    const err = sectionsError(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']);
    expect(err).toMatch(/9 zones or fewer/);
  });

  it('refuses an empty list and non-array shapes', () => {
    expect(sectionsError([])).toMatch(/at least one zone/i);
    expect(sectionsError('Patio')).toMatch(/list of names/i);
    expect(sectionsError('not json')).toMatch(/JSON list/);
  });

  it('refuses blank, oversized and non-string names with the number in hand', () => {
    expect(sectionsError(['   '])).toMatch(/Zone 1 is empty/);
    expect(sectionsError([42])).toMatch(/Zone 1 is not a name/);
    const long = 'x'.repeat(25);
    expect(sectionsError([long])).toMatch(/25 characters/);
  });

  it('refuses duplicates that differ only by capitalisation', () => {
    expect(sectionsError(['Patio', 'PATIO'])).toMatch(/must be distinct/);
  });

  it('refuses markup and control characters', () => {
    expect(sectionsError(['<script>'])).toMatch(/cannot use/);
    expect(sectionsError(['bad\u0000name'])).toMatch(/cannot use/);
  });
});

describe('GET /api/tables/sections', () => {
  it('serves the defaults when nothing is stored, and never hides a zone tables still use', async () => {
    const e = makeEnv({ stored: null, usage: [{ section: 'Terrace', n: 2 }] });
    const { status, body } = await json(await withEnv(e, 'GET', '/api/tables/sections'));
    expect(status).toBe(200);
    expect(body.sections).toEqual(['Patio', 'Main Hall', 'Window', 'VIP Room', 'Bar', 'Terrace']);
    expect(body.custom).toBe(false);
    expect(body.usage.Terrace).toBe(2);
    expect(body.max).toBe(9);
  });

  it('serves the stored order when a manager has customised the list', async () => {
    const e = makeEnv({ stored: '["Bar","Patio"]', usage: [{ section: 'Bar', n: 4 }] });
    const { body } = await json(await withEnv(e, 'GET', '/api/tables/sections'));
    expect(body.sections).toEqual(['Bar', 'Patio']);
    expect(body.custom).toBe(true);
  });

  it('degrades a corrupt stored row to the defaults instead of breaking the floor plan', async () => {
    const e = makeEnv({ stored: '{"not":"a list"}', usage: [] });
    const { body } = await json(await withEnv(e, 'GET', '/api/tables/sections'));
    expect(body.sections).toEqual(['Patio', 'Main Hall', 'Window', 'VIP Room', 'Bar']);
    expect(body.custom).toBe(false);
  });
});

describe('POST /api/tables/sections — rename', () => {
  it('renames, carries the tables along, stores the list and audits all three facts', async () => {
    const e = makeEnv({
      stored: null,
      usage: [{ section: 'Patio', n: 2 }],
      cascadeChanges: 2,
    });
    const { status, body } = await json(
      await withEnv(e, 'POST', '/api/tables/sections', { action: 'rename', from: 'Patio', to: 'Terrace' })
    );
    expect(status).toBe(200);
    expect(body.sections).toEqual(['Terrace', 'Main Hall', 'Window', 'VIP Room', 'Bar']);
    expect(body.tablesMoved).toBe(2);

    // The cascade: every table whose zone was Patio (any casing/spacing) is rewritten.
    const cascade = e.runs.find((r) => /UPDATE tables/i.test(r.sql));
    expect(cascade.params).toEqual(['Terrace', 'Patio']);

    // The stored list matches what the pickers should show next read.
    expect(e.state.settingsValue).toBe(JSON.stringify(body.sections));

    // The audit entry names the move.
    const audit = e.runs.find((r) => /INSERT INTO audit/i.test(r.sql));
    expect(audit).toBeTruthy();
    const reason = audit.params.find((p) => typeof p === 'string' && /renamed/.test(p));
    expect(reason).toMatch(/Terrace/);
    expect(reason).toMatch(/2 tables moved/);
  });

  it('keeps position on rename — the order managers arranged survives', async () => {
    const e = makeEnv({ stored: '["Bar","Patio","Loft"]' });
    const { body } = await json(
      await withEnv(e, 'POST', '/api/tables/sections', { action: 'rename', from: 'Loft', to: 'Attic' })
    );
    expect(body.sections).toEqual(['Bar', 'Patio', 'Attic']);
  });

  it('refuses to rename a zone that does not exist, or onto a name already taken', async () => {
    const e404 = makeEnv({});
    const r404 = await json(
      await withEnv(e404, 'POST', '/api/tables/sections', { action: 'rename', from: 'Cellar', to: 'X' })
    );
    expect(r404.status).toBe(404);

    const eDup = makeEnv({ stored: '["Patio","Bar"]' });
    const rDup = await json(
      await withEnv(eDup, 'POST', '/api/tables/sections', { action: 'rename', from: 'Patio', to: 'Bar' })
    );
    expect(rDup.status).toBe(400);
    expect(rDup.body.error).toMatch(/already a zone/);
  });

  it('is manager-only', async () => {
    const e = makeEnv({});
    const { status } = await json(
      await withEnv(e, 'POST', '/api/tables/sections', { action: 'rename', from: 'Patio', to: 'X' }, WAITER)
    );
    expect(status).toBe(403);
  });
});

describe('POST /api/tables/sections — add', () => {
  it('appends a zone and stores it', async () => {
    const e = makeEnv({});
    const { body } = await json(
      await withEnv(e, 'POST', '/api/tables/sections', { action: 'add', name: 'Terrace' })
    );
    expect(body.sections).toEqual(['Patio', 'Main Hall', 'Window', 'VIP Room', 'Bar', 'Terrace']);
    expect(e.state.settingsValue).toContain('Terrace');
  });

  it('refuses the ninth-plus zone with the reason, not just a number', async () => {
    const nine = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
    const e = makeEnv({ stored: JSON.stringify(nine) });
    const { status, body } = await json(
      await withEnv(e, 'POST', '/api/tables/sections', { action: 'add', name: 'J' })
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/9 zones is the limit/);
  });

  it('refuses a duplicate', async () => {
    const e = makeEnv({});
    const { status } = await json(
      await withEnv(e, 'POST', '/api/tables/sections', { action: 'add', name: 'patio' })
    );
    expect(status).toBe(400);
  });
});

describe('POST /api/tables/sections — remove', () => {
  it('refuses to strand tables: an occupied zone needs a moveTo', async () => {
    const e = makeEnv({ usage: [{ section: 'Patio', n: 3 }] });
    const { status, body } = await json(
      await withEnv(e, 'POST', '/api/tables/sections', { action: 'remove', name: 'Patio' })
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/3 tables sit in "Patio"/);
    expect(body.tables).toBe(3);
  });

  it('moves the tables to the surviving zone the manager named', async () => {
    const e = makeEnv({ usage: [{ section: 'Patio', n: 3 }], cascadeChanges: 3 });
    const { status, body } = await json(
      await withEnv(e, 'POST', '/api/tables/sections', { action: 'remove', name: 'Patio', moveTo: 'Main Hall' })
    );
    expect(status).toBe(200);
    expect(body.tablesMoved).toBe(3);
    expect(body.sections).not.toContain('Patio');
    const cascade = e.runs.find((r) => /UPDATE tables/i.test(r.sql));
    expect(cascade.params).toEqual(['Main Hall', 'Patio']);
    const reason = e.runs.find((r) => /INSERT INTO audit/i.test(r.sql)).params
      .find((p) => typeof p === 'string' && /removed/.test(p));
    expect(reason).toMatch(/moved to "Main Hall"/);
  });

  it('drops an empty zone without asking where anything should go', async () => {
    const e = makeEnv({});
    const { status, body } = await json(
      await withEnv(e, 'POST', '/api/tables/sections', { action: 'remove', name: 'VIP Room' })
    );
    expect(status).toBe(200);
    expect(body.tablesMoved).toBe(0);
    expect(body.sections).not.toContain('VIP Room');
    expect(e.runs.some((r) => /UPDATE tables/i.test(r.sql))).toBe(false);
  });

  it('never removes the last zone', async () => {
    const e = makeEnv({ stored: '["Bar"]' });
    const { status } = await json(
      await withEnv(e, 'POST', '/api/tables/sections', { action: 'remove', name: 'Bar' })
    );
    expect(status).toBe(400);
  });
});

describe('POST /api/tables/sections — reorder', () => {
  it('stores a new order of the same zones', async () => {
    const e = makeEnv({});
    const { status, body } = await json(
      await withEnv(e, 'POST', '/api/tables/sections', {
        action: 'reorder',
        sections: ['Bar', 'VIP Room', 'Window', 'Main Hall', 'Patio'],
      })
    );
    expect(status).toBe(200);
    expect(body.sections[0]).toBe('Bar');
    expect(e.state.settingsValue).toBe(JSON.stringify(body.sections));
  });

  it('refuses an order that adds or drops zones — those are separate decisions', async () => {
    const e = makeEnv({});
    const { status } = await json(
      await withEnv(e, 'POST', '/api/tables/sections', {
        action: 'reorder',
        sections: ['Bar', 'Patio'],
      })
    );
    expect(status).toBe(400);
  });
});

describe('PUT /api/tables/:id — the zone gate on a single table', () => {
  function putEnv() {
    const e = makeEnv({});
    // The PUT branch reads the table row before gating.
    e.env.DB.prepare = vi.fn((sql) => {
      if (/FROM tables WHERE id/i.test(sql)) {
        return {
          bind: () => ({
            all: async () => ({
              results: [{ id: 'T1', number: 1, server: '', section: 'Patio' }],
            }),
            run: async () => ({ meta: { changes: 0 } }),
          }),
          all: async () => ({ results: [{ id: 'T1', number: 1, server: '', section: 'Patio' }] }),
          run: async () => ({ meta: { changes: 0 } }),
        };
      }
      return makeEnv({}).env.DB.prepare(sql);
    });
    return e;
  }

  it('a head-waiter cannot move a table between zones', async () => {
    const e = putEnv();
    const res = await withEnv(e, 'PUT', '/api/tables/T1', { section: 'Bar' }, WAITER);
    const { status, body } = await json(res);
    expect(status).toBe(403);
    expect(body.error).toMatch(/Only a manager can move a table/);
  });

  it('a manager can — and service flows echoing the stored zone pass untouched', async () => {
    const e = putEnv();
    const res = await withEnv(e, 'PUT', '/api/tables/T1', { section: 'Main Hall' }, MANAGER);
    expect(res).toBeNull(); // fell through to the generic handler as designed
  });
});

describe('PUT /api/tables (collection) — the same zone gate, other door', () => {
  function resEnv() {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 1 }, results: [] });
    const prepare = vi.fn((sql) => ({
      bind: (...params) => ({
        all: async () => {
          if (/PRAGMA/i.test(sql)) return { results: [{ name: 'id' }, { name: 'section' }, { name: 'guests' }] };
          if (/FROM tables WHERE id/i.test(sql)) return { results: [{ section: 'Patio' }] };
          return { results: [] };
        },
        run,
      }),
      all: async () => {
        if (/PRAGMA/i.test(sql)) return { results: [{ name: 'id' }, { name: 'section' }, { name: 'guests' }] };
        if (/FROM tables WHERE id/i.test(sql)) return { results: [{ section: 'Patio' }] };
        return { results: [] };
      },
      run,
    }));
    return { env: { DB: { prepare } }, run };
  }

  function resPut(envBundle, body, auth) {
    const path = '/api/tables';
    const url = new URL(API + path);
    const request = new Request(url, {
      method: 'PUT',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
    return handleResources(path, 'PUT', url, request, envBundle.env, auth);
  }

  it('a head-waiter cannot sneak a zone move in with id in the body', async () => {
    const e = resEnv();
    const res = await resPut(e, { id: 'T1', section: 'Bar', guests: 2 }, WAITER);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/Only a manager can move a table/);
  });

  it('a manager moves the table, and an echo of the stored zone passes for anyone', async () => {
    const e = resEnv();
    const ok = await resPut(e, { id: 'T1', section: 'Bar' }, MANAGER);
    expect(ok.status).toBe(200);

    const e2 = resEnv();
    const echo = await resPut(e2, { id: 'T1', section: 'Patio', guests: 3 }, WAITER);
    expect(echo.status).toBe(200);
  });
});

describe('PUT /api/settings/tables.sections — the settings-door guard', () => {  function hrEnv(stored) {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 1 }, results: [] });
    const prepare = vi.fn((sql) => ({
      bind: (...params) => ({
        all: async () =>
          /FROM settings/i.test(sql) && stored != null
            ? { results: [{ key: 'tables.sections', value: stored }] }
            : { results: [] },
        run,
      }),
      all: async () => ({ results: [] }),
      run,
    }));
    return { env: { DB: { prepare } }, run };
  }

  function hrPut(envBundle, value) {
    const path = '/api/settings/tables.sections';
    const url = new URL(API + path);
    const request = new Request(url, {
      method: 'PUT',
      body: JSON.stringify({ value }),
      headers: { 'Content-Type': 'application/json' },
    });
    return handleHR(path, 'PUT', url, request, envBundle.env, MANAGER);
  }

  it('refuses a malformed list at the settings door', async () => {
    const e = hrEnv(null);
    const res = await hrPut(e, '["Patio", 42]');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Zone 2 is not a name/);
  });

  it('accepts a well-formed list so the value stays editable outside the editor', async () => {
    const e = hrEnv(null);
    const res = await hrPut(e, '["Patio","Bar"]');
    expect(res.status).toBe(200);
  });
});
