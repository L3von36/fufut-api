import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { incomeTax } from '../src/lib/payroll.js';

/**
 * The income tax table, pinned to the engine.
 *
 * The bands live in `settings` as data, and migration 025 is the document of
 * record for what they currently are (the Income Tax Amendment Proclamation,
 * in force from 7 July 2025). Two drifts this test catches:
 *
 *   - the migration's JSON is edited without checking it against the
 *     progressive-arithmetic contract the engine expects (continuity at the
 *     band edges);
 *   - the LIVE settings row is edited to something the law does not say —
 *     this file re-derives the migration's table and re-checks the known
 *     figures, so an unexplained change to either fails a suite.
 *
 * §46's rule stands underneath all of it: the engine hard-codes nothing, the
 * table is data, and changing the law means changing a row — with this test
 * updated in the same commit so the two can never quietly disagree.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.join(HERE, '..', 'migrations', '025-income-tax-amendment-2025.sql');

const bands = (() => {
  const sql = readFileSync(MIGRATION, 'utf8');
  const m = sql.match(/SET value = '(\[.*?\])'/s);
  expect(m, 'migration 025 must still carry the band table as a JSON literal').toBeTruthy();
  return JSON.parse(m[1]);
})();

describe('income tax bands (migration 025, effective 2025-07-07)', () => {
  it('stores six bands with the amended thresholds', () => {
    expect(bands.map((b) => b.upTo)).toEqual([2000, 4000, 7000, 10000, 14000, null]);
    expect(bands.map((b) => b.rate)).toEqual([0, 0.15, 0.2, 0.25, 0.3, 0.35]);
  });

  it('is continuous at every band edge — no pay rise should ever cost more than the rise', () => {
    for (const edge of [2000, 4000, 7000, 10000, 14000]) {
      const below = incomeTax(edge, bands);
      const above = incomeTax(edge + 0.01, bands);
      expect(Math.abs(above - below)).toBeLessThan(0.01);
    }
  });

  it('matches the published figures at known salaries', () => {
    // 3,000: 15% of the 1,000 over the 2,000 exemption.
    expect(incomeTax(3000, bands)).toBe(150);
    // 5,000: 150 + 20% of the 1,000 over 4,000.
    expect(incomeTax(5000, bands)).toBe(500);
    // 12,000: 1,650 (at 10,000) + 30% of 2,000.
    expect(incomeTax(12000, bands)).toBe(2250);
    // 15,000: 2,850 (at 14,000) + 35% of 1,000.
    expect(incomeTax(15000, bands)).toBe(3200);
  });

  it('exempts the first 2,000 birr entirely', () => {
    expect(incomeTax(0, bands)).toBe(0);
    expect(incomeTax(1500, bands)).toBe(0);
    expect(incomeTax(2000, bands)).toBe(0);
  });
});
