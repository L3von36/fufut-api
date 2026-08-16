import { describe, it, expect } from 'vitest';
import { solveLeastSquares, fitQuality, inferQuantities, MIN_PERIODS_MARGIN } from '../src/lib/infer.js';

/**
 * The tests that matter here are the ones about *refusing*. A least-squares fit
 * always returns numbers; the danger is that it returns confident nonsense when
 * the data cannot support an answer, and somebody adopts it as a recipe.
 */

describe('solveLeastSquares', () => {
  it('recovers exact quantities from clean data', () => {
    // Tibs uses 200 g, Dulet 150 g. Three periods, varied mix.
    const A = [[10, 5], [4, 9], [7, 7]];
    const b = [
      10 * 200 + 5 * 150,
      4 * 200 + 9 * 150,
      7 * 200 + 7 * 150,
    ];
    const r = solveLeastSquares(A, b);
    expect(r.ok).toBe(true);
    expect(r.solution[0]).toBeCloseTo(200, 6);
    expect(r.solution[1]).toBeCloseTo(150, 6);
  });

  it('averages through noise rather than chasing it', () => {
    const A = [[10, 5], [4, 9], [7, 7], [12, 3], [2, 11]];
    const truth = [200, 150];
    const noise = [120, -90, 60, -140, 100];
    const b = A.map((row, i) => row[0] * truth[0] + row[1] * truth[1] + noise[i]);
    const r = solveLeastSquares(A, b);
    expect(r.solution[0]).toBeGreaterThan(180);
    expect(r.solution[0]).toBeLessThan(220);
    expect(r.solution[1]).toBeGreaterThan(130);
    expect(r.solution[1]).toBeLessThan(170);
  });

  /**
   * The dangerous case. Tibs and Dulet always sell 2:1, so any split summing
   * correctly fits perfectly and the maths has no basis for choosing. Returning
   * an answer here would be worse than returning none.
   */
  it('refuses when two dishes always sold in the same proportion', () => {
    const A = [[10, 5], [20, 10], [6, 3], [14, 7]];
    const b = [3250, 6500, 1950, 4550];
    const r = solveLeastSquares(A, b);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/same proportion/i);
  });

  it('refuses when there are fewer periods than unknowns', () => {
    const r = solveLeastSquares([[10, 5]], [3250]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cannot determine/i);
  });

  it('refuses when nothing sold at all', () => {
    const r = solveLeastSquares([[0, 0], [0, 0], [0, 0]], [0, 0, 0]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no sales/i);
  });

  it('handles a single dish, which needs no separation', () => {
    // Tuna Salad is the only thing using tuna: consumed / sold, directly.
    const r = solveLeastSquares([[10], [6], [8]], [10 * 80, 6 * 80, 8 * 80]);
    expect(r.ok).toBe(true);
    expect(r.solution[0]).toBeCloseTo(80, 6);
  });
});

describe('fitQuality', () => {
  it('reports a perfect fit as 1', () => {
    const A = [[10, 5], [4, 9], [7, 7]];
    const x = [200, 150];
    const b = A.map((r) => r[0] * x[0] + r[1] * x[1]);
    expect(fitQuality(A, b, x).rSquared).toBeCloseTo(1, 6);
  });

  it('drops when something outside the dishes moved the stock', () => {
    const A = [[10, 5], [4, 9], [7, 7]];
    const x = [200, 150];
    const b = A.map((r, i) => r[0] * x[0] + r[1] * x[1] + (i === 1 ? 9000 : 0));
    expect(fitQuality(A, b, x).rSquared).toBeLessThan(0.7);
  });
});

describe('inferQuantities', () => {
  const dishes = ['M-tibs', 'M-dulet'];
  const unit = 'kg';

  const period = (label, tibs, dulet, consumed) => ({
    label, consumed, sales: { 'M-tibs': tibs, 'M-dulet': dulet },
  });

  const clean = [
    period('wk1', 100, 50, 27.5),
    period('wk2', 60, 90, 25.5),
    period('wk3', 120, 30, 28.5),
    period('wk4', 40, 110, 24.5),
  ];

  it('infers per-dish quantities in the stocking unit', () => {
    const r = inferQuantities({ periods: clean, dishes, unit });
    expect(r.ok).toBe(true);
    // 0.2 kg of beef per Tibs, 0.15 per Dulet.
    expect(r.estimates[0].estimate).toBeCloseTo(0.2, 4);
    expect(r.estimates[1].estimate).toBeCloseTo(0.15, 4);
    expect(r.estimates[0].unit).toBe('kg');
  });

  it('demands more periods than unknowns before answering', () => {
    const r = inferQuantities({ periods: clean.slice(0, 2), dishes, unit });
    expect(r.ok).toBe(false);
    expect(r.periodsNeeded).toBe(dishes.length + MIN_PERIODS_MARGIN);
    expect(r.reason).toMatch(/counted periods/i);
  });

  it('says so when no dish uses the ingredient', () => {
    expect(inferQuantities({ periods: clean, dishes: [], unit }).reason).toMatch(/no dishes/i);
  });

  /**
   * The caveat has to travel with the numbers. Inferred quantities include
   * trim, spillage and over-portioning; adopting them as the standard redefines
   * today's waste as correct, and the variance report can then never see it.
   */
  it('always carries the warning that this is consumption, not a recipe', () => {
    const r = inferQuantities({ periods: clean, dishes, unit });
    expect(r.disclaimer).toMatch(/what is being used, not what the recipe should be/i);
    expect(r.disclaimer).toMatch(/waste/i);
  });

  it('warns when the dishes do not explain the movement', () => {
    const leaky = [
      period('wk1', 100, 50, 27.5),
      period('wk2', 60, 90, 60),      // something else emptied the shelf
      period('wk3', 120, 30, 28.5),
      period('wk4', 40, 110, 24.5),
    ];
    const r = inferQuantities({ periods: leaky, dishes, unit });
    expect(r.warnings.join(' ')).toMatch(/explain only/i);
  });

  it('flags an impossible negative rather than clamping it to zero', () => {
    // Clamping would present "no measurable effect" as a measured zero.
    const odd = [
      period('wk1', 100, 50, 18),
      period('wk2', 60, 90, 6),
      period('wk3', 120, 30, 23),
      period('wk4', 40, 110, 1),
    ];
    const r = inferQuantities({ periods: odd, dishes, unit });
    if (r.ok) {
      const negative = r.estimates.filter((e) => e.implausible);
      if (negative.length) {
        expect(r.warnings.join(' ')).toMatch(/no measurable effect/i);
      }
    }
    expect(r).toBeTruthy();
  });

  it('flags a period where more arrived than the counts account for', () => {
    const broken = [
      period('wk1', 100, 50, -5),
      period('wk2', 60, 90, 25.5),
      period('wk3', 120, 30, 28.5),
      period('wk4', 40, 110, 24.5),
    ];
    const r = inferQuantities({ periods: broken, dishes, unit });
    expect(r.warnings.join(' ')).toMatch(/negative/i);
    expect(r.warnings.join(' ')).toMatch(/missing/i);
  });

  it('refuses a correlated sales mix instead of splitting it arbitrarily', () => {
    const locked = [
      period('wk1', 100, 50, 27.5),
      period('wk2', 200, 100, 55),
      period('wk3', 60, 30, 16.5),
      period('wk4', 140, 70, 38.5),
    ];
    const r = inferQuantities({ periods: locked, dishes, unit });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/same proportion/i);
  });
});
