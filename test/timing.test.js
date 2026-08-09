import { describe, it, expect } from 'vitest';
import {
  ITEM_FLOW,
  stampColumnFor,
  isValidItemStatus,
  flowIndex,
  deriveOrderStatus,
  minutesBetween,
  itemDurations,
  averageByCategory,
  normaliseLines,
} from '../src/lib/timing.js';

describe('status helpers', () => {
  it('maps each state to the column that records it', () => {
    expect(stampColumnFor('preparing')).toBe('preparing_at');
    expect(stampColumnFor('ready')).toBe('ready_at');
    expect(stampColumnFor('served')).toBe('served_at');
    // 'new' is the creation state; created_at already records it.
    expect(stampColumnFor('new')).toBeNull();
    expect(stampColumnFor('nonsense')).toBeNull();
  });

  it('validates and orders states', () => {
    expect(ITEM_FLOW).toEqual(['new', 'preparing', 'ready', 'served']);
    expect(isValidItemStatus('READY')).toBe(true);
    expect(isValidItemStatus('exploded')).toBe(false);
    expect(flowIndex('served')).toBeGreaterThan(flowIndex('preparing'));
    expect(flowIndex('nope')).toBe(-1);
  });
});

describe('deriveOrderStatus', () => {
  it('is served only when every line landed', () => {
    expect(deriveOrderStatus(['served', 'served'])).toBe('served');
    expect(deriveOrderStatus(['served', 'ready'])).toBe('ready');
  });

  // The whole point of the pessimistic rule: one dish still cooking must not
  // let the order read as ready.
  it('is not ready while anything is still being made', () => {
    expect(deriveOrderStatus(['ready', 'preparing'])).toBe('preparing');
    expect(deriveOrderStatus(['served', 'new'])).toBe('preparing');
  });

  it('is new only when nothing has started', () => {
    expect(deriveOrderStatus(['new', 'new'])).toBe('new');
  });

  it('returns null when there are no usable lines', () => {
    expect(deriveOrderStatus([])).toBeNull();
    expect(deriveOrderStatus(null)).toBeNull();
    expect(deriveOrderStatus(['bogus'])).toBeNull();
  });
});

describe('minutesBetween', () => {
  it('measures forward intervals', () => {
    expect(minutesBetween('2026-08-11T10:00:00Z', '2026-08-11T10:10:00Z')).toBe(10);
    expect(minutesBetween('2026-08-11T10:00:00Z', '2026-08-11T10:00:30Z')).toBe(0.5);
  });

  it('refuses missing or reversed timestamps rather than inventing a number', () => {
    expect(minutesBetween(null, '2026-08-11T10:10:00Z')).toBeNull();
    expect(minutesBetween('2026-08-11T10:00:00Z', null)).toBeNull();
    expect(minutesBetween('2026-08-11T10:10:00Z', '2026-08-11T10:00:00Z')).toBeNull();
    expect(minutesBetween('not-a-time', '2026-08-11T10:00:00Z')).toBeNull();
  });
});

describe('itemDurations', () => {
  it('splits the queue, the cook, and the whole journey', () => {
    const d = itemDurations({
      created_at: '2026-08-11T10:00:00Z',
      preparing_at: '2026-08-11T10:02:00Z',
      ready_at: '2026-08-11T10:09:00Z',
      served_at: '2026-08-11T10:10:00Z',
    });
    expect(d.waited).toBe(2);
    expect(d.cooked).toBe(7);
    expect(d.toTable).toBe(10);
  });

  it('leaves unreached stages null', () => {
    const d = itemDurations({ created_at: '2026-08-11T10:00:00Z', preparing_at: '2026-08-11T10:02:00Z' });
    expect(d.waited).toBe(2);
    expect(d.cooked).toBeNull();
    expect(d.toTable).toBeNull();
  });

  it('handles a missing item', () => {
    expect(itemDurations(null)).toEqual({ waited: null, cooked: null, toTable: null });
  });
});

describe('averageByCategory', () => {
  const items = [
    { category: 'Hot Drinks', created_at: '2026-08-11T10:00:00Z', served_at: '2026-08-11T10:08:00Z' },
    { category: 'Hot Drinks', created_at: '2026-08-11T11:00:00Z', served_at: '2026-08-11T11:12:00Z' },
    { category: 'Food', created_at: '2026-08-11T10:00:00Z', served_at: '2026-08-11T10:20:00Z' },
    // Never served - must not be counted as zero.
    { category: 'Food', created_at: '2026-08-11T12:00:00Z', served_at: null },
  ];

  it('averages only what actually reached the table', () => {
    const rows = averageByCategory(items);
    const hot = rows.find((r) => r.category === 'Hot Drinks');
    const food = rows.find((r) => r.category === 'Food');

    expect(hot.served).toBe(2);
    expect(hot.averageMinutes).toBe(10); // (8 + 12) / 2
    expect(hot.fastestMinutes).toBe(8);
    expect(hot.slowestMinutes).toBe(12);

    expect(food.served).toBe(1);        // the unserved line is excluded
    expect(food.averageMinutes).toBe(20);
  });

  it('sorts slowest category first, since that is what needs attention', () => {
    expect(averageByCategory(items)[0].category).toBe('Food');
  });

  it('omits categories with nothing served rather than reporting zero', () => {
    const rows = averageByCategory([{ category: 'Pastry', created_at: '2026-08-11T10:00:00Z', served_at: null }]);
    expect(rows).toEqual([]);
  });

  it('buckets missing categories under a label instead of dropping them', () => {
    const rows = averageByCategory([
      { created_at: '2026-08-11T10:00:00Z', served_at: '2026-08-11T10:05:00Z' },
    ]);
    expect(rows[0].category).toBe('Uncategorised');
  });

  it('handles empty input', () => {
    expect(averageByCategory([])).toEqual([]);
    expect(averageByCategory(null)).toEqual([]);
  });
});

describe('normaliseLines', () => {
  it('reads the cart shape the POS actually sends', () => {
    const lines = normaliseLines([
      { menuItemId: 'MI1', name: 'Macchiato', basePrice: 130, qty: 2, modifiers: [{ name: 'Extra shot' }] },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ lineNo: 0, menuItemId: 'MI1', name: 'Macchiato', qty: 2, unitPrice: 130 });
    expect(JSON.parse(lines[0].modifiers)).toEqual([{ name: 'Extra shot' }]);
  });

  it('accepts the legacy price/quantity spelling', () => {
    const lines = normaliseLines([{ name: 'TEA', price: 70, quantity: 3 }]);
    expect(lines[0]).toMatchObject({ name: 'TEA', unitPrice: 70, qty: 3 });
  });

  it('parses a JSON string, which is how orders.items is stored', () => {
    const lines = normaliseLines('[{"name":"Macchiato","qty":1,"price":80}]');
    expect(lines[0]).toMatchObject({ name: 'Macchiato', qty: 1, unitPrice: 80 });
  });

  it('keeps quantity on one row rather than exploding it', () => {
    expect(normaliseLines([{ name: 'Coffee', qty: 4, price: 65 }])).toHaveLength(1);
  });

  it('defaults a bad quantity to one instead of zero', () => {
    expect(normaliseLines([{ name: 'Coffee', qty: 0, price: 65 }])[0].qty).toBe(1);
    expect(normaliseLines([{ name: 'Coffee', qty: 'many', price: 65 }])[0].qty).toBe(1);
  });

  it('drops entries that are not orderable lines', () => {
    expect(normaliseLines([null, {}, { name: '   ' }, 'junk'])).toEqual([]);
  });

  // Regression: this is the string real orders actually carried, and treating
  // it as unparseable meant live orders produced no tracking rows at all - the
  // kitchen had nothing to mark and every timing stayed empty.
  it('parses the flat summary the POS writes to orders.items', () => {
    const lines = normaliseLines('1xMacchiato, 1xFut breakfast Gebeta');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ name: 'Macchiato', qty: 1 });
    expect(lines[1]).toMatchObject({ name: 'Fut breakfast Gebeta', qty: 1 });
  });

  it('keeps dish names that contain a comma intact', () => {
    const lines = normaliseLines('1xPineapple, MANGO and ORANGE Juice, 2xTEA');
    expect(lines).toHaveLength(2);
    expect(lines[0].name).toBe('Pineapple, MANGO and ORANGE Juice');
    expect(lines[1]).toMatchObject({ name: 'TEA', qty: 2 });
  });

  it('strips modifiers and notes from the flat form', () => {
    const lines = normaliseLines('2x Latte [oat-milk, vanilla] (extra hot), 1x Espresso');
    expect(lines[0]).toMatchObject({ name: 'Latte', qty: 2 });
    expect(lines[1]).toMatchObject({ name: 'Espresso', qty: 1 });
  });

  it('survives malformed input', () => {
    expect(normaliseLines('just some prose')).toEqual([]);
    expect(normaliseLines(null)).toEqual([]);
    expect(normaliseLines({ name: 'not an array' })).toEqual([]);
  });

  it('numbers lines in order so the kitchen ticket keeps its sequence', () => {
    const lines = normaliseLines([{ name: 'A' }, { name: 'B' }, { name: 'C' }]);
    expect(lines.map((l) => l.lineNo)).toEqual([0, 1, 2]);
  });
});
