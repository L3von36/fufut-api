import { describe, it, expect } from 'vitest';
import { selectRecipeVariant, modifierNames, consumptionPerServing } from '../src/lib/inventory.js';

/** A coffee with three sizes and no default, plus the spec's quantities. */
const SIZED = [
  { id: 'RC-s', menu_item_id: 'M1', variant: 'Small', status: 'active' },
  { id: 'RC-m', menu_item_id: 'M1', variant: 'Medium', status: 'active' },
  { id: 'RC-l', menu_item_id: 'M1', variant: 'Large', status: 'active' },
];

const WITH_DEFAULT = [{ id: 'RC-d', menu_item_id: 'M1', variant: null, status: 'active' }, ...SIZED];

describe('modifierNames', () => {
  it('reads the POS shape', () => {
    expect(modifierNames(JSON.stringify([{ name: 'Large', priceDelta: 10 }]))).toEqual(['Large']);
  });

  it('reads plain string arrays, which is what production actually stores', () => {
    // menu_items.modifiers holds ["Hot"], ["warm or cold"] today.
    expect(modifierNames('["Hot","Large"]')).toEqual(['Hot', 'Large']);
  });

  it('reads an already-parsed array', () => {
    expect(modifierNames([{ name: 'Small' }, 'Hot'])).toEqual(['Small', 'Hot']);
  });

  it('falls back to splitting a bare comma-separated string', () => {
    expect(modifierNames('Large, extra shot')).toEqual(['Large', 'extra shot']);
  });

  it('treats empty and malformed input as no modifiers', () => {
    expect(modifierNames('')).toEqual([]);
    expect(modifierNames(null)).toEqual([]);
    expect(modifierNames(undefined)).toEqual([]);
    expect(modifierNames('[]')).toEqual([]);
  });
});

describe('selectRecipeVariant', () => {
  it('picks the recipe matching the size ordered', () => {
    expect(selectRecipeVariant(SIZED, '["Large"]').id).toBe('RC-l');
    expect(selectRecipeVariant(SIZED, '["Small"]').id).toBe('RC-s');
  });

  it('matches case-insensitively', () => {
    // "Large" on the menu and "large" in a modifier are the same thing to
    // everybody except a string comparison.
    expect(selectRecipeVariant(SIZED, '["large"]').id).toBe('RC-l');
    expect(selectRecipeVariant(SIZED, '["  LARGE  "]').id).toBe('RC-l');
  });

  it('ignores modifiers that are not sizes', () => {
    // "Hot" is a preparation instruction, not a different bill of materials.
    expect(selectRecipeVariant(WITH_DEFAULT, '["Hot"]').id).toBe('RC-d');
  });

  it('finds the size among several modifiers', () => {
    expect(selectRecipeVariant(WITH_DEFAULT, '["Hot","Large","no sugar"]').id).toBe('RC-l');
  });

  it('uses the default when nothing was ordered', () => {
    expect(selectRecipeVariant(WITH_DEFAULT, '').id).toBe('RC-d');
    expect(selectRecipeVariant(WITH_DEFAULT, null).id).toBe('RC-d');
  });

  /**
   * A dish whose recipes are all variants, ordered without one. Consuming
   * nothing would report a dish that costs the business nothing, which is worse
   * than consuming a plausible size.
   */
  it('falls back to a variant rather than consuming nothing', () => {
    expect(selectRecipeVariant(SIZED, '')).not.toBeNull();
    expect(selectRecipeVariant(SIZED, '').id).toBe('RC-s');
  });

  it('returns null only when the dish has no recipe at all', () => {
    // Bottled water and other bought-in goods legitimately have none.
    expect(selectRecipeVariant([], '["Large"]')).toBeNull();
    expect(selectRecipeVariant(null, '')).toBeNull();
  });

  it('never picks an archived version', () => {
    const archived = [
      { id: 'RC-old', variant: 'Large', status: 'archived' },
      { id: 'RC-new', variant: 'Large', status: 'active' },
    ];
    expect(selectRecipeVariant(archived, '["Large"]').id).toBe('RC-new');
  });

  /**
   * The property that makes this safe to ship: a dish with no variant recipes
   * behaves exactly as it did before variants existed.
   */
  it('leaves single-recipe dishes completely unchanged', () => {
    const plain = [{ id: 'RC-only', variant: null, status: 'active' }];
    expect(selectRecipeVariant(plain, '["Hot"]').id).toBe('RC-only');
    expect(selectRecipeVariant(plain, '["Large"]').id).toBe('RC-only');
    expect(selectRecipeVariant(plain, '').id).toBe('RC-only');
  });
});

describe('the spec’s §32 example end to end', () => {
  const COFFEE = { id: 'I-coffee', name: 'Coffee beans', unit: 'kg', avg_cost: 1000 };

  // Small 12 g, Medium 18 g, Large 25 g — the spec's own quantities.
  const LINES = {
    'RC-s': { qty: 12, unit: 'g' },
    'RC-m': { qty: 18, unit: 'g' },
    'RC-l': { qty: 25, unit: 'g' },
  };

  it('consumes a different quantity for each size', () => {
    const forSize = (mods) => {
      const recipe = selectRecipeVariant(SIZED, mods);
      return consumptionPerServing(LINES[recipe.id], COFFEE);
    };

    expect(forSize('["Small"]')).toBeCloseTo(0.012, 6);
    expect(forSize('["Medium"]')).toBeCloseTo(0.018, 6);
    expect(forSize('["Large"]')).toBeCloseTo(0.025, 6);
  });

  /**
   * The bug this closes. All three sizes previously resolved to one recipe, so
   * a small over-consumed by 6 g and a large under-consumed by 7 g on every
   * cup — and the variance report attributed the gap to the kitchen.
   */
  it('no longer charges every size the medium’s quantity', () => {
    const small = consumptionPerServing(LINES[selectRecipeVariant(SIZED, '["Small"]').id], COFFEE);
    const large = consumptionPerServing(LINES[selectRecipeVariant(SIZED, '["Large"]').id], COFFEE);
    expect(small).not.toBeCloseTo(large, 6);
    expect(large).toBeGreaterThan(small);
  });
});
