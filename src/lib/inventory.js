/**
 * The recipe and inventory engine.
 *
 * Everything here is a pure function over plain rows. The handlers do the I/O;
 * this module does the arithmetic, so the calculations the business actually
 * depends on — how much coffee 100 sales should have consumed, how many meals
 * the fridge can produce, what a macchiato costs to make — can be tested
 * directly rather than inferred from a screenshot of a dashboard.
 *
 * ── The two conventions that everything else follows ────────────────────────
 *
 * 1. **A recipe describes usable ingredient; stock holds what was bought.**
 *    A recipe says 150 g of meat, meaning 150 g on the plate. Stock holds raw
 *    meat, and trimming loses some of it. With `yield_pct = 85`, serving 150 g
 *    consumes 150 / 0.85 ≈ 176.5 g of stock. Dividing, not multiplying, is the
 *    whole point: the spec's own worked example turns 100 kg of raw meat into
 *    566 meals rather than 666, and multiplying would give 784.
 *
 * 2. **A recipe yields `yield_qty` servings.** It is 1 for a coffee and 100 for
 *    a pot cooked in the morning. Batch production is therefore the same
 *    mechanism as a single drink rather than a second system — §34 falls out of
 *    §16 for free.
 */

import { convert, areCompatible, roundQty } from './units.js';

/**
 * Read the modifier names off an order line.
 *
 * The column holds whatever the client sent: the POS serialises
 * `[{name, priceDelta}]`, the website and older rows use plain strings, and a
 * line with none is an empty string. All three shapes appear in production, so
 * all three are handled rather than assumed away.
 */
export function modifierNames(modifiers) {
  let list = modifiers;
  if (typeof list === 'string') {
    if (!list.trim()) return [];
    try {
      list = JSON.parse(list);
    } catch {
      // Not JSON — a bare "Large" or "Hot, extra shot".
      return list.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  if (!Array.isArray(list)) return [];
  return list
    .map((m) => (typeof m === 'string' ? m : m && m.name))
    .filter(Boolean)
    .map((s) => String(s).trim());
}

/**
 * Choose which recipe version a sold line was actually made from — §32.
 *
 * A dish may have several active recipes, one per variant (Small / Medium /
 * Large), plus a default whose `variant` is null. The line's modifiers say
 * which was ordered.
 *
 * Matching is by name and case-insensitive, because "Large" on the menu and
 * "large" in a modifier are the same thing to everybody except a string
 * comparison. No attempt is made to classify which modifiers *are* sizes: a
 * modifier matters here only if a variant recipe was written for it, which
 * means adding sizes to one dish never changes how any other dish behaves.
 *
 * Falls back to the default recipe, and returns null only when the dish has no
 * recipe at all — a legitimate state for bought-in goods like bottled water.
 */
export function selectRecipeVariant(recipes, modifiers) {
  const active = (recipes || []).filter((r) => !r.status || r.status === 'active');
  if (!active.length) return null;

  const names = modifierNames(modifiers).map((n) => n.toLowerCase());
  if (names.length) {
    const match = active.find(
      (r) => r.variant && names.includes(String(r.variant).trim().toLowerCase())
    );
    if (match) return match;
  }

  // No variant ordered, or one with no recipe of its own — "extra hot" is a
  // preparation instruction, not a different bill of materials.
  const fallback = active.find((r) => !r.variant);
  // A dish with only variant recipes and no default: rather than consuming
  // nothing, use the first variant so the sale still moves stock. Reporting
  // nothing consumed would look like a dish that costs the business nothing.
  return fallback || active[0];
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Usable fraction of an item as stocked. Defaults to 1 (no loss) and is clamped
 * to (0, 1]: a yield of 0 would divide by zero, and above 100% would create
 * ingredient out of nothing.
 */
export function yieldFactor(item) {
  const pct = num(item && item.yield_pct, 100);
  if (pct <= 0) return 1;
  return Math.min(pct, 100) / 100;
}

/**
 * How much of one ingredient a single serving consumes, expressed in the
 * item's stocking unit.
 *
 * @param {object} line  recipe_items row: { qty, unit, waste_pct }
 * @param {object} item  inventory row:    { unit, yield_pct }
 * @param {number} yieldQty  servings the recipe produces
 * @returns {number} quantity in `item.unit`
 * @throws  on an incompatible unit — never silently guessed
 */
export function consumptionPerServing(line, item, yieldQty = 1) {
  const servings = num(yieldQty, 1) || 1;
  const perServingInRecipeUnit = num(line.qty) / servings;

  // Preparation loss on this line specifically — grounds in the portafilter,
  // milk left in the jug. Raises consumption above what reaches the cup.
  const withWaste = perServingInRecipeUnit * (1 + num(line.waste_pct) / 100);

  // Recipe unit → stocking unit. Throws if the two measure different things.
  const inStockUnit = convert(withWaste, line.unit, item.unit);

  // Trim/prep yield on the ingredient itself. See convention 1 above.
  return inStockUnit / yieldFactor(item);
}

/**
 * Total consumption for selling `qty` of a menu item.
 *
 * @param {Array}  lines  recipe_items rows
 * @param {Map}    itemsById  inventory rows keyed by id
 * @param {number} qty        how many were sold
 * @param {object} [opts]
 * @param {boolean} [opts.includePackaging=true]  a dine-in coffee in a ceramic
 *        cup consumes no takeaway cup, so the caller decides.
 * @returns {{lines: Array, errors: Array}}
 */
export function expandRecipe(lines, itemsById, qty = 1, opts = {}) {
  const { includePackaging = true, yieldQty = 1 } = opts;
  const out = [];
  const errors = [];

  for (const line of lines || []) {
    if (line.is_packaging && !includePackaging) continue;
    const item = itemsById.get(String(line.inventory_id));
    if (!item) {
      // A recipe pointing at a deleted ingredient is a data problem to report,
      // not a reason to refuse the sale or to consume nothing silently.
      errors.push(`Ingredient ${line.inventory_id} is not in inventory`);
      continue;
    }
    try {
      const per = consumptionPerServing(line, item, yieldQty);
      out.push({
        inventoryId: item.id,
        name: item.name,
        unit: item.unit,
        perServing: per,
        quantity: per * num(qty, 1),
        isPackaging: !!line.is_packaging,
        unitCost: num(item.avg_cost, num(item.cost)),
      });
    } catch (e) {
      errors.push(`${item.name}: ${e.message}`);
    }
  }

  return { lines: out, errors };
}

/**
 * What a recipe costs to make, split as §30 asks.
 *
 * Uses weighted average cost where purchases have established one, falling back
 * to the manually entered `cost`. Labour, rent and utilities are deliberately
 * absent — this is ingredient cost, and calling the difference from the selling
 * price anything other than a *gross* margin would be wrong.
 */
export function recipeCost(lines, itemsById, opts = {}) {
  const { lines: expanded, errors } = expandRecipe(lines, itemsById, 1, opts);
  let ingredient = 0;
  let packaging = 0;

  for (const l of expanded) {
    const cost = l.quantity * l.unitCost;
    if (l.isPackaging) packaging += cost;
    else ingredient += cost;
  }

  return {
    ingredientCost: Math.round(ingredient * 100) / 100,
    packagingCost: Math.round(packaging * 100) / 100,
    totalCost: Math.round((ingredient + packaging) * 100) / 100,
    errors,
  };
}

/**
 * Selling price against cost.
 *
 * `grossMargin`, never "profit": labour, rent, electricity, water and tax are
 * not in this number, and the spec is explicit that conflating them is the
 * mistake to avoid.
 */
export function menuItemMargin(price, cost) {
  const p = num(price);
  const c = num(cost);
  const margin = p - c;
  return {
    price: Math.round(p * 100) / 100,
    cost: Math.round(c * 100) / 100,
    grossMargin: Math.round(margin * 100) / 100,
    grossMarginPct: p > 0 ? Math.round((margin / p) * 1000) / 10 : null,
  };
}

/**
 * Theoretical servings obtainable from a quantity of one ingredient.
 *
 * The spec's headline calculation: 100 kg of coffee at 18 g a cup is about
 * 5,555 cups. Explicitly an estimate — it assumes no spillage beyond the
 * recipe's own waste allowance and that the recipe is followed exactly.
 */
export function theoreticalServings(stockQty, item, line, yieldQty = 1) {
  const per = consumptionPerServing(line, item, yieldQty);
  if (per <= 0) return null;
  return Math.floor(num(stockQty) / per);
}

/**
 * "How many can we make?" — §28.
 *
 * Every ingredient gives a capacity; the smallest is the answer, and the
 * ingredient that produced it is what to buy next. Reporting the average or the
 * total here would be worse than useless: you cannot make 666 macchiatos from
 * enough coffee for 1,111 if there is only milk for 666.
 */
export function productionCapacity(lines, itemsById, stockByItem, opts = {}) {
  const { yieldQty = 1, includePackaging = true } = opts;
  const perIngredient = [];
  const errors = [];

  for (const line of lines || []) {
    if (line.is_packaging && !includePackaging) continue;
    const item = itemsById.get(String(line.inventory_id));
    if (!item) {
      errors.push(`Ingredient ${line.inventory_id} is not in inventory`);
      continue;
    }
    // An optional line (an extra shot, a garnish) must not cap production of
    // the dish it is optional to.
    if (line.optional) continue;

    try {
      const per = consumptionPerServing(line, item, yieldQty);
      const stock = num(stockByItem.get(String(item.id)), num(item.stock));
      const capacity = per > 0 ? Math.floor(stock / per) : Infinity;
      perIngredient.push({
        inventoryId: item.id,
        name: item.name,
        unit: item.unit,
        stock: roundQty(stock, item.unit),
        perServing: roundQty(per, item.unit),
        capacity,
      });
    } catch (e) {
      errors.push(`${item.name}: ${e.message}`);
    }
  }

  if (!perIngredient.length) {
    return { possible: null, limiting: null, perIngredient: [], errors };
  }

  const limiting = perIngredient.reduce((a, b) => (b.capacity < a.capacity ? b : a));
  return {
    possible: Number.isFinite(limiting.capacity) ? limiting.capacity : null,
    limiting: limiting.name,
    limitingId: limiting.inventoryId,
    perIngredient: perIngredient.sort((a, b) => a.capacity - b.capacity),
    errors,
  };
}

/**
 * Expected against actual — §21, the calculation the whole ledger exists for.
 *
 * `expected` comes from recipes multiplied by what was sold; `actual` comes from
 * the movements that were recorded. A gap is a question, not an accusation: the
 * spec is explicit that variance must not be presented as theft, so the result
 * carries possible explanations and no verdict.
 */
export function consumptionVariance(expected, actual, unit) {
  const e = num(expected);
  const a = num(actual);
  const variance = a - e;
  return {
    expected: roundQty(e, unit),
    actual: roundQty(a, unit),
    variance: roundQty(variance, unit),
    // Percentage of expected, so a 0.4 kg gap on 1.8 kg reads as 22% and the
    // same gap on 200 kg reads as 0.2%.
    variancePct: e > 0 ? Math.round((variance / e) * 1000) / 10 : null,
    direction: Math.abs(variance) < 1e-9 ? 'none' : variance > 0 ? 'over' : 'under',
    possibleReasons:
      Math.abs(variance) < 1e-9
        ? []
        : variance > 0
          ? ['Waste or spillage', 'Portions larger than the recipe', 'Preparation loss', 'Recipe out of date', 'Stock count error']
          : ['Portions smaller than the recipe', 'Recipe out of date', 'Stock count error', 'Deliveries not yet recorded'],
  };
}

/**
 * Opening + purchases − expected usage against what is actually there — §27.
 */
export function stockReconciliation({ opening, purchased, expectedUsage, wasted, actualClosing, unit }) {
  const expectedClosing =
    num(opening) + num(purchased) - num(expectedUsage) - num(wasted);
  return {
    opening: roundQty(opening, unit),
    purchased: roundQty(purchased, unit),
    expectedUsage: roundQty(expectedUsage, unit),
    wasted: roundQty(wasted, unit),
    expectedClosing: roundQty(expectedClosing, unit),
    actualClosing: roundQty(actualClosing, unit),
    variance: roundQty(num(actualClosing) - expectedClosing, unit),
  };
}

/**
 * How long stock will last — §29.
 *
 * Returns null rather than a number when there is not enough history. A
 * forecast built on two days of trading is a guess wearing a number's clothes,
 * and the spec asks specifically that predictions are withheld when the data is
 * insufficient.
 */
export const MIN_FORECAST_DAYS = 7;

export function forecastRunout(stock, dailyUsage, daysOfHistory, asOf = new Date()) {
  const usage = num(dailyUsage);
  if (num(daysOfHistory) < MIN_FORECAST_DAYS) {
    return {
      daysRemaining: null,
      stockoutDate: null,
      confidence: 'insufficient-data',
      note: `Needs at least ${MIN_FORECAST_DAYS} days of usage history; have ${num(daysOfHistory)}.`,
    };
  }
  if (usage <= 0) {
    return {
      daysRemaining: null,
      stockoutDate: null,
      confidence: 'no-usage',
      note: 'No usage recorded over the period, so no run-out can be projected.',
    };
  }

  const days = num(stock) / usage;
  const out = new Date(asOf.getTime() + days * 86400000);
  return {
    daysRemaining: Math.floor(days),
    stockoutDate: out.toISOString().slice(0, 10),
    dailyUsage: Math.round(usage * 1000) / 1000,
    // Longer history, steadier estimate. Named rather than scored, because a
    // decimal confidence would imply a rigour this does not have.
    confidence: num(daysOfHistory) >= 28 ? 'good' : 'provisional',
    note: 'Estimate based on average usage. Actual demand varies.',
  };
}

/**
 * What to reorder and how much — §30.
 *
 * Recommends up to `target_stock`, falling back to twice the reorder point when
 * no target is set, which keeps the list useful before every item has been
 * fully configured.
 */
export function reorderSuggestion(item, currentStock) {
  const stock = num(currentStock, num(item.stock));
  const point = item.reorder_point != null ? num(item.reorder_point) : num(item.min_level);
  if (!point || stock > point) return null;

  const target = num(item.target_stock) || point * 2;
  const suggested = Math.max(0, target - stock);
  return {
    inventoryId: item.id,
    name: item.name,
    unit: item.unit,
    currentStock: roundQty(stock, item.unit),
    reorderPoint: roundQty(point, item.unit),
    targetStock: roundQty(target, item.unit),
    suggestedQty: roundQty(suggested, item.unit),
    preferredSupplierId: item.preferred_supplier_id || null,
    urgency: stock <= 0 ? 'out-of-stock' : stock <= point / 2 ? 'critical' : 'low',
    estimatedCost: Math.round(suggested * num(item.avg_cost, num(item.cost)) * 100) / 100,
  };
}

/**
 * Weighted average cost after receiving more of something.
 *
 * Using the latest price instead would make margin swing on every delivery;
 * averaging across what is actually on the shelf is what makes a food-cost
 * figure comparable week to week.
 */
export function newAverageCost(currentQty, currentAvg, incomingQty, incomingCost) {
  const q0 = num(currentQty);
  const q1 = num(incomingQty);
  const total = q0 + q1;
  if (total <= 0) return num(incomingCost);
  // Stock can be negative if usage was recorded before a delivery; falling back
  // to the incoming price avoids producing a nonsensical average from it.
  if (q0 <= 0) return num(incomingCost);
  const value = q0 * num(currentAvg, num(incomingCost)) + q1 * num(incomingCost);
  return Math.round((value / total) * 10000) / 10000;
}

/**
 * Purchase analysis — §41 / spec §17.
 *
 * Every figure here is theoretical and labelled as such. Actual revenue comes
 * from completed sales, never from this.
 */
export function purchaseAnalysis({ qty, unit, totalCost, item, line, sellingPrice, yieldQty = 1 }) {
  const stockQty = areCompatible(unit, item.unit) ? convert(qty, unit, item.unit) : num(qty);
  const unitCost = num(qty) > 0 ? num(totalCost) / num(qty) : 0;
  const servings = line ? theoreticalServings(stockQty, item, line, yieldQty) : null;
  const perServingCost = servings && servings > 0 ? num(totalCost) / servings : null;

  return {
    purchased: `${roundQty(qty, unit)} ${unit}`,
    totalCost: Math.round(num(totalCost) * 100) / 100,
    costPerUnit: Math.round(unitCost * 100) / 100,
    theoreticalServings: servings,
    ingredientCostPerServing: perServingCost != null ? Math.round(perServingCost * 100) / 100 : null,
    potentialRevenue:
      servings != null && sellingPrice != null
        ? Math.round(servings * num(sellingPrice) * 100) / 100
        : null,
    // Repeated in the payload so a screen cannot render the number without it.
    disclaimer:
      'Theoretical. Assumes the recipe is followed exactly and every serving sells. Actual revenue comes from completed sales.',
  };
}
