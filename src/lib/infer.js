/**
 * Recipe inference from stock movement.
 *
 * Answers "how much beef does a Tibs actually use?" without anybody weighing
 * anything, by solving what the shelf did against what was sold.
 *
 * ── The model ───────────────────────────────────────────────────────────────
 *
 * Between two physical counts, for one ingredient:
 *
 *     consumed = opening count + purchases − waste − closing count
 *
 * and that consumption was caused by the dishes sold in between:
 *
 *     q₁·(dish 1 sold) + q₂·(dish 2 sold) + … = consumed
 *
 * One period is one equation in as many unknowns as there are dishes using the
 * ingredient — unsolvable. Several periods with *different* sales mixes give an
 * over-determined system, and least squares gives the per-dish quantities.
 *
 * ── What this measures, and why that matters ────────────────────────────────
 *
 * It infers **actual consumption**, not the intended recipe. Trim, spillage,
 * over-portioning and theft are all inside the number. That makes it excellent
 * for finding problems and wrong for setting a costing standard: adopt the
 * output verbatim and you bake today's waste into tomorrow's target, after
 * which the variance report can never see that waste again because it has been
 * redefined as correct.
 *
 * So the output is deliberately shaped as a *suggestion with diagnostics*, not
 * a recipe. `estimate` is what the shelf implies; the caller decides whether it
 * is the recipe or evidence of a problem with it.
 *
 * ── Where it fails, loudly ──────────────────────────────────────────────────
 *
 * If two dishes always sell in roughly the same ratio, no amount of data can
 * separate them — the columns are linearly dependent and the fit will happily
 * return a confident, arbitrary split. That is the dangerous failure, so
 * collinearity is detected and refused rather than reported.
 */

/** Enough periods to be worth solving at all, beyond the number of unknowns. */
export const MIN_PERIODS_MARGIN = 2;

/** Pivot below this, relative to the matrix scale, means the system is degenerate. */
const SINGULAR_TOLERANCE = 1e-9;

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/**
 * Solve the least-squares problem A·x ≈ b via the normal equations.
 *
 * Normal equations square the condition number, which is a real weakness for
 * ill-conditioned systems — but the alternative (a QR decomposition) is a lot
 * of numerical code to maintain for matrices that are at most a dozen columns
 * wide, and the conditioning check below refuses precisely the cases where the
 * difference would matter.
 *
 * @returns {{ok: boolean, solution?: number[], reason?: string, pivotRatio?: number}}
 */
export function solveLeastSquares(A, b) {
  const m = A.length;
  if (!m) return { ok: false, reason: 'no observations' };
  const n = A[0].length;
  if (!n) return { ok: false, reason: 'no unknowns' };
  if (b.length !== m) return { ok: false, reason: 'row count mismatch' };
  if (m < n) return { ok: false, reason: `${m} periods cannot determine ${n} quantities` };

  // AᵀA and Aᵀb
  const AtA = Array.from({ length: n }, () => new Array(n).fill(0));
  const Atb = new Array(n).fill(0);
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      const aij = num(A[i][j]);
      Atb[j] += aij * num(b[i]);
      for (let k = 0; k < n; k++) AtA[j][k] += aij * num(A[i][k]);
    }
  }

  // Scale reference for judging whether a pivot is meaningfully non-zero.
  let scale = 0;
  for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) scale = Math.max(scale, Math.abs(AtA[j][k]));
  if (scale === 0) return { ok: false, reason: 'no sales recorded in any period' };

  // Gaussian elimination with partial pivoting.
  const M = AtA.map((row, j) => [...row, Atb[j]]);
  let worstPivot = Infinity;

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivotRow][col])) pivotRow = r;
    }
    const pivot = Math.abs(M[pivotRow][col]);
    worstPivot = Math.min(worstPivot, pivot / scale);

    // A vanishing pivot means two dishes moved together in every period. The
    // fit would still return numbers; they would be arbitrary.
    if (pivot / scale < SINGULAR_TOLERANCE) {
      return {
        ok: false,
        reason: 'these dishes always sold in the same proportion, so their quantities cannot be told apart',
        pivotRatio: pivot / scale,
      };
    }

    [M[col], M[pivotRow]] = [M[pivotRow], M[col]];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / M[col][col];
      if (!f) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }

  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
    x[i] = s / M[i][i];
  }

  return { ok: true, solution: x, pivotRatio: worstPivot };
}

/** How well the fitted quantities reproduce the observed consumption. */
export function fitQuality(A, b, x) {
  let ssRes = 0;
  let ssTot = 0;
  const mean = b.reduce((s, v) => s + num(v), 0) / (b.length || 1);
  for (let i = 0; i < A.length; i++) {
    const predicted = A[i].reduce((s, a, j) => s + num(a) * num(x[j]), 0);
    ssRes += (num(b[i]) - predicted) ** 2;
    ssTot += (num(b[i]) - mean) ** 2;
  }
  return {
    // Share of the variation in consumption the quantities explain. Low means
    // something outside the dishes is moving the stock.
    rSquared: ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : null,
    residualPerPeriod: A.length ? Math.sqrt(ssRes / A.length) : null,
  };
}

/**
 * Infer per-dish quantities for one ingredient.
 *
 * @param {object} input
 * @param {Array<{label, consumed, sales: Record<string, number>}>} input.periods
 * @param {string[]} input.dishes   menu item ids, defining column order
 * @param {string}   input.unit     the ingredient's stocking unit, for the output
 */
export function inferQuantities({ periods, dishes, unit }) {
  const warnings = [];
  const usable = (periods || []).filter((p) => Number.isFinite(num(p.consumed, NaN)));

  if (!dishes || !dishes.length) {
    return { ok: false, reason: 'no dishes use this ingredient', warnings };
  }
  if (usable.length < dishes.length + MIN_PERIODS_MARGIN) {
    return {
      ok: false,
      reason: `needs at least ${dishes.length + MIN_PERIODS_MARGIN} counted periods for ${dishes.length} dish(es); have ${usable.length}`,
      periodsAvailable: usable.length,
      periodsNeeded: dishes.length + MIN_PERIODS_MARGIN,
      warnings,
    };
  }

  // Consumption is reported as a positive quantity; a negative one means more
  // arrived than the counts account for, which is a data problem rather than an
  // observation about recipes.
  for (const p of usable) {
    if (num(p.consumed) < 0) {
      warnings.push(`Period ${p.label}: consumption is negative (${p.consumed}) — a purchase or count is probably missing.`);
    }
  }

  const A = usable.map((p) => dishes.map((d) => num(p.sales && p.sales[d])));
  const b = usable.map((p) => num(p.consumed));

  const solved = solveLeastSquares(A, b);
  if (!solved.ok) return { ok: false, reason: solved.reason, warnings };

  const quality = fitQuality(A, b, solved.solution);
  if (quality.rSquared !== null && quality.rSquared < 0.7) {
    warnings.push(
      `The dishes explain only ${Math.round(quality.rSquared * 100)}% of the movement. Something else is emptying this shelf — waste, an unrecorded dish, or counts taken at inconsistent times.`
    );
  }

  const estimates = dishes.map((dish, j) => {
    const value = solved.solution[j];
    return {
      menuItemId: dish,
      // Rounded to milligram-scale precision in the stocking unit; more digits
      // than the data supports would imply a confidence it does not have.
      estimate: Math.round(value * 1e6) / 1e6,
      unit,
      // A dish cannot consume a negative quantity. When the fit produces one it
      // means that dish's effect is indistinguishable from noise, so it is
      // flagged rather than silently clamped to zero.
      implausible: value < 0,
    };
  });

  for (const e of estimates) {
    if (e.implausible) {
      warnings.push(`${e.menuItemId}: fitted to a negative quantity, which is impossible — treat as "no measurable effect", not as a measurement.`);
    }
  }

  return {
    ok: true,
    estimates,
    periodsUsed: usable.length,
    quality,
    conditioning: solved.pivotRatio,
    warnings,
    // Repeated in the payload so no screen can render these as a recipe without
    // the caveat travelling with them.
    disclaimer:
      'These are inferred from actual stock movement, so they include trim, spillage and over-portioning. They describe what is being used, not what the recipe should be. Adopting them verbatim bakes current waste into the standard, after which the variance report can no longer see it.',
  };
}
