import { describe, it, expect } from 'vitest';
import { allocateFEFO, sortForConsumption } from '../src/lib/batches.js';

/**
 * Three cartons of milk. Note that B2 was received *later* than B3 but expires
 * *sooner* — which is the whole reason this is FEFO and not FIFO.
 */
const MILK = [
  { id: 'B1', expiry_date: '2026-08-20', received_at: '2026-08-01', qty_remaining: 10 },
  { id: 'B2', expiry_date: '2026-08-12', received_at: '2026-08-08', qty_remaining: 5 },
  { id: 'B3', expiry_date: '2026-08-15', received_at: '2026-08-05', qty_remaining: 8 },
];

describe('sortForConsumption', () => {
  it('orders by expiry, soonest first', () => {
    expect(sortForConsumption(MILK).map((b) => b.id)).toEqual(['B2', 'B3', 'B1']);
  });

  /**
   * The carton bought later can be the one that goes off first. Using the
   * oldest-received batch would leave it on the shelf to spoil, which is the
   * failure FEFO exists to prevent.
   */
  it('does not simply use the oldest delivery', () => {
    const order = sortForConsumption(MILK).map((b) => b.id);
    expect(order[0]).toBe('B2');          // received second-latest
    expect(order[0]).not.toBe('B1');      // received first
  });

  it('puts undated batches last, behind anything that can spoil', () => {
    const mixed = [
      { id: 'NODATE', expiry_date: null, received_at: '2026-01-01', qty_remaining: 100 },
      ...MILK,
    ];
    expect(sortForConsumption(mixed).map((b) => b.id).at(-1)).toBe('NODATE');
  });

  it('falls back to oldest received when nothing has an expiry', () => {
    // With no dates, FEFO degenerates to FIFO, which is the right answer.
    const undated = [
      { id: 'X', expiry_date: null, received_at: '2026-03-01', qty_remaining: 5 },
      { id: 'Y', expiry_date: null, received_at: '2026-01-01', qty_remaining: 5 },
    ];
    expect(sortForConsumption(undated).map((b) => b.id)).toEqual(['Y', 'X']);
  });

  it('is stable and does not mutate the input', () => {
    const before = MILK.map((b) => b.id);
    sortForConsumption(MILK);
    expect(MILK.map((b) => b.id)).toEqual(before);
  });
});

describe('allocateFEFO', () => {
  it('takes everything from the first-to-expire batch when it covers the need', () => {
    const { allocations, shortfall } = allocateFEFO(MILK, 3);
    expect(allocations).toEqual([{ batchId: 'B2', qty: 3, expiryDate: '2026-08-12' }]);
    expect(shortfall).toBe(0);
  });

  it('spills into the next batch once the first is exhausted', () => {
    const { allocations, shortfall } = allocateFEFO(MILK, 9);
    expect(allocations).toEqual([
      { batchId: 'B2', qty: 5, expiryDate: '2026-08-12' },
      { batchId: 'B3', qty: 4, expiryDate: '2026-08-15' },
    ]);
    expect(shortfall).toBe(0);
  });

  it('walks every batch for a large draw', () => {
    const { allocations, shortfall } = allocateFEFO(MILK, 23);
    expect(allocations.map((a) => a.batchId)).toEqual(['B2', 'B3', 'B1']);
    expect(allocations.reduce((s, a) => s + a.qty, 0)).toBe(23);
    expect(shortfall).toBe(0);
  });

  /**
   * Stock going further than the batches account for is real — deliveries
   * recorded late, opening stock that predates batch tracking. It is reported,
   * not thrown: refusing the movement would block a sale that already happened.
   */
  it('reports a shortfall rather than refusing the movement', () => {
    const { allocations, shortfall } = allocateFEFO(MILK, 30);
    expect(allocations.reduce((s, a) => s + a.qty, 0)).toBe(23);
    expect(shortfall).toBe(7);
  });

  /**
   * With no batches, the entire quantity is unallocated — `shortfall` is the
   * unallocated remainder, so 5 is the literal truth here, not a bug.
   *
   * It never reaches a caller as "5 missing": `consumeFromBatches` returns null
   * the moment an item has no open batches, because most items are not
   * batch-tracked at all and reporting a shortfall for them would imply stock
   * had gone astray when nothing had.
   */
  it('allocates nothing when there are no batches, and says all of it is uncovered', () => {
    expect(allocateFEFO([], 5)).toEqual({ allocations: [], shortfall: 5 });
    expect(allocateFEFO(null, 5).allocations).toEqual([]);
  });

  it('treats the quantity as a magnitude, since consumption arrives negative', () => {
    // postMovement passes a signed quantity; -3 must draw 3, not nothing.
    expect(allocateFEFO(MILK, -3).allocations).toEqual([
      { batchId: 'B2', qty: 3, expiryDate: '2026-08-12' },
    ]);
  });

  it('skips a batch that is already empty', () => {
    const withEmpty = [{ id: 'EMPTY', expiry_date: '2026-08-01', received_at: '2026-07-01', qty_remaining: 0 }, ...MILK];
    expect(allocateFEFO(withEmpty, 2).allocations[0].batchId).toBe('B2');
  });

  it('does nothing for a zero draw', () => {
    expect(allocateFEFO(MILK, 0)).toEqual({ allocations: [], shortfall: 0 });
  });

  it('handles fractional quantities without drifting', () => {
    const { allocations, shortfall } = allocateFEFO(MILK, 5.25);
    expect(allocations).toEqual([
      { batchId: 'B2', qty: 5, expiryDate: '2026-08-12' },
      { batchId: 'B3', qty: 0.25, expiryDate: '2026-08-15' },
    ]);
    expect(shortfall).toBe(0);
  });

  /**
   * The reason the allocation is stored on the movement instead of re-derived
   * at reversal time: by then the first-to-expire batch is usually a different
   * carton, and restoring into it would move quantity onto the wrong date.
   */
  it('names the batch and its expiry, so a reversal can be exact', () => {
    const { allocations } = allocateFEFO(MILK, 6);
    expect(allocations[0]).toHaveProperty('batchId');
    expect(allocations[0]).toHaveProperty('expiryDate', '2026-08-12');
  });
});
