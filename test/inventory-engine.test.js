import { describe, it, expect } from 'vitest';
import { convert, areCompatible, toBase, packToBase, isKnownUnit } from '../src/lib/units.js';
import {
  consumptionPerServing,
  expandRecipe,
  recipeCost,
  menuItemMargin,
  theoreticalServings,
  productionCapacity,
  consumptionVariance,
  stockReconciliation,
  forecastRunout,
  reorderSuggestion,
  newAverageCost,
  yieldFactor,
} from '../src/lib/inventory.js';

/** Inventory fixtures, in the units Fufut actually stocks them in. */
const COFFEE = { id: 'I-coffee', name: 'Coffee beans', unit: 'kg', stock: 20, cost: 1000, avg_cost: 1000 };
const MILK = { id: 'I-milk', name: 'Milk', unit: 'l', stock: 80, cost: 60, avg_cost: 60 };
const SUGAR = { id: 'I-sugar', name: 'Sugar', unit: 'kg', stock: 30, cost: 90, avg_cost: 90 };
const CUP = { id: 'I-cup', name: 'Takeaway cup', unit: 'piece', stock: 900, cost: 5, avg_cost: 5, is_packaging: 1 };
const MEAT = { id: 'I-meat', name: 'Meat', unit: 'kg', stock: 100, cost: 700, avg_cost: 700, yield_pct: 85 };
const OIL = { id: 'I-oil', name: 'Oil', unit: 'l', stock: 50, cost: 200, avg_cost: 200 };

function itemMap(...items) {
  return new Map(items.map((i) => [i.id, i]));
}

describe('unit conversion', () => {
  it('converts within mass and volume', () => {
    expect(convert(1, 'kg', 'g')).toBe(1000);
    expect(convert(18, 'g', 'kg')).toBeCloseTo(0.018, 6);
    expect(convert(1, 'litre', 'ml')).toBe(1000);
    expect(convert(250, 'ml', 'l')).toBeCloseTo(0.25, 6);
  });

  it('accepts the spellings staff actually type', () => {
    for (const u of ['KG', 'Kg', 'kilogram', 'grams', 'litres', 'Liter', 'pcs']) {
      expect(isKnownUnit(u)).toBe(true);
    }
  });

  // Turning grams of milk into millilitres needs a density this system does not
  // have. A plausible wrong number in a stock ledger is worse than an error.
  it('refuses to convert across dimensions rather than guessing', () => {
    expect(() => convert(200, 'g', 'ml')).toThrow(/different things/i);
    expect(areCompatible('g', 'ml')).toBe(false);
  });

  // Nothing in the world fixes how many cups are in a box.
  it('refuses to convert between count units without a pack size', () => {
    expect(() => convert(1, 'box', 'piece')).toThrow(/pack size/i);
    expect(areCompatible('box', 'piece')).toBe(false);
    expect(areCompatible('piece', 'piece')).toBe(true);
  });

  it('converts packs once the item declares a pack size', () => {
    expect(packToBase(3, 50, 'piece')).toEqual({ qty: 150, unit: 'piece' });
    expect(() => packToBase(3, 0, 'piece')).toThrow(/pack size/i);
  });

  it('rejects an unknown unit instead of treating it as one', () => {
    expect(() => convert(1, 'handful', 'g')).toThrow(/unknown unit/i);
    expect(toBase(2, 'kg')).toEqual({ qty: 2000, unit: 'g' });
  });
});

describe('consumption per serving', () => {
  it('converts recipe units into stocking units', () => {
    // 18 g of coffee out of stock held in kg.
    const per = consumptionPerServing({ qty: 18, unit: 'g' }, COFFEE);
    expect(per).toBeCloseTo(0.018, 6);
  });

  it('divides a batch recipe across the servings it yields', () => {
    // A pot producing 100 servings from 15 kg of meat is 150 g each.
    const per = consumptionPerServing({ qty: 15, unit: 'kg' }, { ...MEAT, yield_pct: 100 }, 100);
    expect(per).toBeCloseTo(0.15, 6);
  });

  it('raises consumption by the line’s own waste allowance', () => {
    const per = consumptionPerServing({ qty: 18, unit: 'g', waste_pct: 10 }, COFFEE);
    expect(per).toBeCloseTo(0.0198, 6);
  });

  /**
   * The direction that matters. Serving 150 g of an ingredient that trims to
   * 85% consumes 176.5 g of stock, not 127.5 g. Multiplying here is what turns
   * the spec's 566 meals into 784.
   */
  it('divides by prep yield so trimming increases what is consumed', () => {
    const per = consumptionPerServing({ qty: 150, unit: 'g' }, MEAT);
    expect(per).toBeCloseTo(0.17647, 4);
    expect(per).toBeGreaterThan(0.15);
  });

  it('treats a missing or nonsensical yield as no loss', () => {
    expect(yieldFactor({})).toBe(1);
    expect(yieldFactor({ yield_pct: 0 })).toBe(1);
    expect(yieldFactor({ yield_pct: 150 })).toBe(1);
    expect(yieldFactor({ yield_pct: 85 })).toBeCloseTo(0.85, 6);
  });
});

describe('smart yield — the spec’s worked examples', () => {
  it('100 kg of coffee at 18 g a cup is about 5,555 cups', () => {
    expect(theoreticalServings(100, COFFEE, { qty: 18, unit: 'g' })).toBe(5555);
  });

  it('100 kg of sugar at 10 g a tea is 10,000 teas', () => {
    expect(theoreticalServings(100, SUGAR, { qty: 10, unit: 'g' })).toBe(10000);
  });

  it('50 litres of oil at 25 ml a portion is 2,000 portions', () => {
    expect(theoreticalServings(50, OIL, { qty: 25, unit: 'ml' })).toBe(2000);
  });

  it('100 kg of meat at 150 g a meal is 666 meals before yield', () => {
    const noTrim = { ...MEAT, yield_pct: 100 };
    expect(theoreticalServings(100, noTrim, { qty: 150, unit: 'g' })).toBe(666);
  });

  it('…and 566 meals once 85% usable yield is applied', () => {
    // The spec's own second calculation, and the reason yield divides.
    expect(theoreticalServings(100, MEAT, { qty: 150, unit: 'g' })).toBe(566);
  });
});

describe('production capacity — what can we make?', () => {
  const macchiato = [
    { inventory_id: 'I-coffee', qty: 18, unit: 'g' },
    { inventory_id: 'I-milk', qty: 120, unit: 'ml' },
    { inventory_id: 'I-sugar', qty: 5, unit: 'g' },
    { inventory_id: 'I-cup', qty: 1, unit: 'piece', is_packaging: 1 },
  ];
  const stock = new Map([
    ['I-coffee', 20],
    ['I-milk', 80],
    ['I-sugar', 30],
    ['I-cup', 900],
  ]);

  it('takes the smallest capacity and names the limiting ingredient', () => {
    // The spec's example: coffee 1,111, milk 666, sugar 6,000, cups 900.
    const cap = productionCapacity(macchiato, itemMap(COFFEE, MILK, SUGAR, CUP), stock);
    expect(cap.possible).toBe(666);
    expect(cap.limiting).toBe('Milk');
  });

  it('reports every ingredient’s capacity, worst first', () => {
    const cap = productionCapacity(macchiato, itemMap(COFFEE, MILK, SUGAR, CUP), stock);
    const byName = Object.fromEntries(cap.perIngredient.map((i) => [i.name, i.capacity]));
    expect(byName['Coffee beans']).toBe(1111);
    expect(byName['Milk']).toBe(666);
    expect(byName['Sugar']).toBe(6000);
    expect(byName['Takeaway cup']).toBe(900);
    expect(cap.perIngredient[0].name).toBe('Milk');
  });

  it('ignores packaging when the drink is served in the café', () => {
    // A dine-in macchiato in a ceramic cup consumes no takeaway cup, so cups
    // must not cap what the kitchen can serve to the room.
    const cap = productionCapacity(macchiato, itemMap(COFFEE, MILK, SUGAR, CUP), stock, {
      includePackaging: false,
    });
    expect(cap.perIngredient.some((i) => i.name === 'Takeaway cup')).toBe(false);
    expect(cap.possible).toBe(666);
  });

  it('does not let an optional garnish cap the dish', () => {
    const withOptional = [...macchiato, { inventory_id: 'I-sugar', qty: 999, unit: 'kg', optional: 1 }];
    const cap = productionCapacity(withOptional, itemMap(COFFEE, MILK, SUGAR, CUP), stock);
    expect(cap.possible).toBe(666);
  });

  it('reports a missing ingredient instead of silently making it free', () => {
    const cap = productionCapacity(macchiato, itemMap(COFFEE, MILK, SUGAR), stock);
    expect(cap.errors.join(' ')).toMatch(/not in inventory/i);
  });
});

describe('costing', () => {
  const macchiato = [
    { inventory_id: 'I-coffee', qty: 18, unit: 'g' },
    { inventory_id: 'I-milk', qty: 120, unit: 'ml' },
    { inventory_id: 'I-cup', qty: 1, unit: 'piece', is_packaging: 1 },
  ];

  it('costs 18 g of coffee at 1,000 ETB/kg as 18 ETB', () => {
    const cost = recipeCost(
      [{ inventory_id: 'I-coffee', qty: 18, unit: 'g' }],
      itemMap(COFFEE)
    );
    expect(cost.ingredientCost).toBe(18);
  });

  it('separates packaging from ingredient cost', () => {
    const cost = recipeCost(macchiato, itemMap(COFFEE, MILK, CUP));
    expect(cost.ingredientCost).toBeCloseTo(25.2, 1); // 18 coffee + 7.2 milk
    expect(cost.packagingCost).toBe(5);
    expect(cost.totalCost).toBeCloseTo(30.2, 1);
  });

  it('calls the difference a gross margin, and reports a percentage', () => {
    const m = menuItemMargin(60, 18);
    expect(m.grossMargin).toBe(42);
    expect(m.grossMarginPct).toBe(70);
    expect(m).not.toHaveProperty('profit');
  });

  it('does not divide by zero on a free item', () => {
    expect(menuItemMargin(0, 0).grossMarginPct).toBeNull();
  });
});

describe('expected against actual consumption', () => {
  it('reports the spec’s 0.4 kg gap as an over-consumption', () => {
    // 100 coffees × 18 g = 1.8 kg expected; 2.2 kg actually moved.
    const v = consumptionVariance(1.8, 2.2, 'kg');
    expect(v.variance).toBeCloseTo(0.4, 3);
    expect(v.direction).toBe('over');
    expect(v.variancePct).toBeCloseTo(22.2, 1);
  });

  it('offers explanations and never names theft', () => {
    const v = consumptionVariance(1.8, 2.2, 'kg');
    expect(v.possibleReasons.length).toBeGreaterThan(0);
    expect(JSON.stringify(v).toLowerCase()).not.toContain('theft');
    expect(JSON.stringify(v).toLowerCase()).not.toContain('steal');
  });

  it('reports a clean reconciliation as no variance', () => {
    expect(consumptionVariance(1.8, 1.8, 'kg').direction).toBe('none');
  });

  it('reconciles opening, purchases and usage against the shelf', () => {
    // The spec's worked example: 20 + 10 − 8 = 22 expected, 20.5 actual.
    const r = stockReconciliation({
      opening: 20, purchased: 10, expectedUsage: 8, wasted: 0,
      actualClosing: 20.5, unit: 'kg',
    });
    expect(r.expectedClosing).toBe(22);
    expect(r.variance).toBeCloseTo(-1.5, 3);
  });
});

describe('forecasting', () => {
  it('projects days remaining from average usage', () => {
    // 12 kg at 1.5 kg a day is 8 days.
    const f = forecastRunout(12, 1.5, 30, new Date('2026-08-10T00:00:00Z'));
    expect(f.daysRemaining).toBe(8);
    expect(f.stockoutDate).toBe('2026-08-18');
    expect(f.confidence).toBe('good');
  });

  // The spec asks specifically that a prediction is withheld rather than
  // fabricated when the history is too short to support one.
  it('refuses to forecast on insufficient history', () => {
    const f = forecastRunout(12, 1.5, 3);
    expect(f.daysRemaining).toBeNull();
    expect(f.confidence).toBe('insufficient-data');
  });

  it('flags a short-but-usable history as provisional', () => {
    expect(forecastRunout(12, 1.5, 10).confidence).toBe('provisional');
  });

  it('does not divide by zero when nothing was used', () => {
    const f = forecastRunout(12, 0, 30);
    expect(f.daysRemaining).toBeNull();
    expect(f.confidence).toBe('no-usage');
  });

  it('labels every forecast as an estimate', () => {
    expect(forecastRunout(12, 1.5, 30).note).toMatch(/estimate/i);
  });
});

describe('reorder', () => {
  it('recommends topping up to the target', () => {
    const s = reorderSuggestion(
      { ...COFFEE, reorder_point: 15, target_stock: 45, preferred_supplier_id: 'SUP1' },
      12
    );
    expect(s.suggestedQty).toBe(33);
    expect(s.urgency).toBe('low');
    expect(s.preferredSupplierId).toBe('SUP1');
  });

  it('says nothing about an item that is comfortably stocked', () => {
    expect(reorderSuggestion({ ...COFFEE, reorder_point: 15 }, 40)).toBeNull();
  });

  it('escalates as stock falls', () => {
    expect(reorderSuggestion({ ...COFFEE, reorder_point: 15 }, 5).urgency).toBe('critical');
    expect(reorderSuggestion({ ...COFFEE, reorder_point: 15 }, 0).urgency).toBe('out-of-stock');
  });

  it('falls back to min_level so the list works before items are configured', () => {
    const s = reorderSuggestion({ ...COFFEE, min_level: 10, reorder_point: null }, 8);
    expect(s).not.toBeNull();
    expect(s.reorderPoint).toBe(10);
    expect(s.targetStock).toBe(20);
  });
});

describe('weighted average cost', () => {
  it('averages across what is on the shelf rather than jumping to the new price', () => {
    // 10 kg at 1,000 plus 10 kg at 1,200 averages to 1,100.
    expect(newAverageCost(10, 1000, 10, 1200)).toBe(1100);
  });

  it('adopts the incoming price when there was nothing left', () => {
    expect(newAverageCost(0, 1000, 10, 1200)).toBe(1200);
  });

  it('does not produce a nonsense average from negative stock', () => {
    expect(newAverageCost(-5, 1000, 10, 1200)).toBe(1200);
  });
});

describe('recipe expansion for a sale', () => {
  const tea = [
    { inventory_id: 'I-sugar', qty: 10, unit: 'g' },
    { inventory_id: 'I-cup', qty: 1, unit: 'piece', is_packaging: 1 },
  ];

  it('scales with quantity sold', () => {
    const { lines } = expandRecipe(tea, itemMap(SUGAR, CUP), 100);
    const sugar = lines.find((l) => l.name === 'Sugar');
    expect(sugar.quantity).toBeCloseTo(1, 6); // 100 × 10 g = 1 kg
  });

  it('collects a bad unit as an error rather than consuming nothing quietly', () => {
    const broken = [{ inventory_id: 'I-sugar', qty: 10, unit: 'ml' }];
    const { lines, errors } = expandRecipe(broken, itemMap(SUGAR), 1);
    expect(lines).toHaveLength(0);
    expect(errors[0]).toMatch(/Sugar/);
  });
});
