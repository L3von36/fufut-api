import { describe, it, expect, vi } from 'vitest';
import { handlePublicStats } from '../src/handlers/stats.js';

/**
 * The public counters on the landing page.
 *
 * These numbers face every visitor, so the contract pinned here is that each
 * metric is honest about what it counts and each curated value arrives as a
 * plain number: real trades on top of a pre-POS baseline for the two counted
 * metrics, the calendar for years, and clamped, settings-curated facts for
 * the three the till cannot count. The website matches these keys to slots
 * by name — a new key here must never re-pair someone else's label.
 *
 * D1 fake keyed on the shape of the SQL, matching orders-transfer.test.js.
 */
function makeEnv({ settingsRows = [], settingsThrow = false, ordersCount = 0, cups = 0 } = {}) {
  const bound = [];
  const prepare = vi.fn(function (sql) {
    return {
      bind: (...params) => {
        bound.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        return {
          all: async () => {
            if (settingsThrow && /FROM settings/.test(sql)) throw new Error('no such table: settings');
            if (/FROM settings/.test(sql)) return { results: settingsRows };
            if (/order_items/i.test(sql)) return { results: [{ cups }] };
            if (/FROM orders/.test(sql)) return { results: [{ n: ordersCount }] };
            return { results: [] };
          },
        };
      },
    };
  });
  return { DB: { prepare }, _bound: bound };
}

describe('handlePublicStats', () => {
  it('serves honest zeros and code defaults on an empty database', async () => {
    const res = await handlePublicStats(makeEnv());
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.happyCustomers).toBe(0);
    expect(body.cupsServed).toBe(0);
    expect(body.yearsServing).toBe(new Date().getFullYear() - 2017);
    expect(body.awards).toBe(14);
    expect(body.coffeeOrigins).toBe(3);
    expect(body.happyPercent).toBe(99);
  });

  it('adds real trades on top of the pre-POS baselines', async () => {
    const env = makeEnv({
      settingsRows: [
        { key: 'stats.baseline_customers', value: '48000' },
        { key: 'stats.baseline_cups', value: '620000' },
        { key: 'venue.founded_year', value: '2016' },
      ],
      ordersCount: 19,
      cups: 3,
    });
    const body = await (await handlePublicStats(env)).json();

    expect(body.happyCustomers).toBe(48019);
    expect(body.cupsServed).toBe(620003);
    expect(body.yearsServing).toBe(new Date().getFullYear() - 2016);
  });

  it('curated brand facts come from settings, clamped to sane ranges', async () => {
    const env = makeEnv({
      settingsRows: [
        { key: 'stats.coffee_origins', value: '15' },
        { key: 'stats.happy_percent', value: '150' },
        { key: 'stats.awards', value: '7' },
      ],
    });
    const body = await (await handlePublicStats(env)).json();

    expect(body.coffeeOrigins).toBe(15);
    expect(body.happyPercent).toBe(100); // clamped, a percentage cannot exceed 100
    expect(body.awards).toBe(7);
  });

  it('ignores negative baselines instead of subtracting history', async () => {
    const env = makeEnv({
      settingsRows: [
        { key: 'stats.baseline_customers', value: '-500' },
        { key: 'stats.baseline_cups', value: '-1' },
      ],
      ordersCount: 5,
      cups: 2,
    });
    const body = await (await handlePublicStats(env)).json();

    expect(body.happyCustomers).toBe(5);
    expect(body.cupsServed).toBe(2);
  });

  it('keeps serving defaults when the settings table does not exist yet', async () => {
    const res = await handlePublicStats(makeEnv({ settingsThrow: true, ordersCount: 4, cups: 1 }));
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.happyCustomers).toBe(4);
    expect(body.cupsServed).toBe(1);
    expect(body.coffeeOrigins).toBe(3);
    expect(body.happyPercent).toBe(99);
  });

  it('counts cups only in beverage categories passed by the cup-category setting', async () => {
    const env = makeEnv();
    await handlePublicStats(env);

    const cupsQuery = env._bound.find((b) => /order_items/i.test(b.sql));
    expect(cupsQuery).toBeTruthy();
    expect(cupsQuery.params).toEqual(['coffee', 'drinks']);
    expect(cupsQuery.sql).toMatch(/o\.voided_at IS NULL/);
  });
});
