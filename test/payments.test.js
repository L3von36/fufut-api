import { describe, it, expect } from 'vitest';
import { orderFinancials } from '../src/handlers/payments.js';
import { diffFields } from '../src/lib/audit.js';

/**
 * The distinction these tests exist to protect: `orders.total` is what the
 * guest hands over and therefore includes the tip, but a tip is not the
 * restaurant's money. Every revenue figure has to use netSales, and this is the
 * one place the subtraction is written down.
 */
describe('orderFinancials', () => {
  it('separates the tip from the restaurant’s share', () => {
    const fin = orderFinancials({ total: 660, tip: 60 }, []);
    expect(fin.total).toBe(660);
    expect(fin.tip).toBe(60);
    expect(fin.netSales).toBe(600);
  });

  it('treats an order with no tip as entirely net sales', () => {
    expect(orderFinancials({ total: 600, tip: 0 }, []).netSales).toBe(600);
  });

  it('handles a missing tip column as zero rather than NaN', () => {
    // Rows written before migration 005 have no tip at all. A NaN here would
    // propagate silently into every revenue total on the dashboard.
    const fin = orderFinancials({ total: 600 }, []);
    expect(fin.tip).toBe(0);
    expect(fin.netSales).toBe(600);
  });

  it('sums a split bill across methods', () => {
    const fin = orderFinancials({ total: 1000, tip: 0 }, [
      { amount: 400 },
      { amount: 600 },
    ]);
    expect(fin.paid).toBe(1000);
    expect(fin.outstanding).toBe(0);
    expect(fin.settled).toBe(true);
  });

  it('reports what is still owed on a part-paid bill', () => {
    const fin = orderFinancials({ total: 1000, tip: 0 }, [{ amount: 400 }]);
    expect(fin.paid).toBe(400);
    expect(fin.outstanding).toBe(600);
    expect(fin.settled).toBe(false);
  });

  // A refund is a negative payment against the same order rather than an edit
  // or a deletion, so the balance is always the sum and the history survives.
  it('nets a refund off without losing the original payment', () => {
    const fin = orderFinancials({ total: 1000, tip: 0 }, [
      { amount: 1000 },
      { amount: -250 },
    ]);
    expect(fin.paid).toBe(750);
    expect(fin.outstanding).toBe(250);
  });

  it('settles within the half-birr tolerance the POS already uses', () => {
    // The split-bill validator accepts a 0.5 discrepancy; the server must agree,
    // or a bill the till considers paid stays open forever.
    expect(orderFinancials({ total: 1000, tip: 0 }, [{ amount: 999.7 }]).settled).toBe(true);
    expect(orderFinancials({ total: 1000, tip: 0 }, [{ amount: 998 }]).settled).toBe(false);
  });

  it('rounds to whole cents rather than accumulating float error', () => {
    const fin = orderFinancials({ total: 100.1, tip: 0 }, [
      { amount: 33.37 },
      { amount: 33.37 },
      { amount: 33.36 },
    ]);
    expect(fin.paid).toBe(100.1);
    expect(fin.outstanding).toBe(0);
  });
});

describe('audit diffFields', () => {
  it('records only what changed', () => {
    const { from, to } = diffFields(
      { price: 60, name: 'Macchiato' },
      { price: 70, name: 'Macchiato' }
    );
    expect(to).toEqual({ price: 70 });
    expect(from).toEqual({ price: 60 });
  });

  it('reports nothing when an update rewrote identical values', () => {
    const { to } = diffFields({ price: 60 }, { price: 60 });
    expect(Object.keys(to)).toHaveLength(0);
  });

  it('compares objects by value, not identity', () => {
    // Otherwise every update carrying a modifiers array would look like a change
    // to it, and the log would fill with writes that moved nothing.
    const { to } = diffFields({ mods: ['oat'] }, { mods: ['oat'] });
    expect(Object.keys(to)).toHaveLength(0);
  });

  it('never copies a credential into the log', () => {
    // The log is manager-readable and exportable to the accountant, so anything
    // secret landing in it outlives the row it came from.
    const { from, to } = diffFields(
      { password_hash: 'old', role: 'cashier' },
      { password_hash: 'new', role: 'manager' }
    );
    expect(to).toEqual({ role: 'manager' });
    expect(from).toEqual({ role: 'cashier' });
    expect(JSON.stringify({ from, to })).not.toContain('new');
  });

  it('treats a create as all-new rather than a diff', () => {
    const { from, to } = diffFields(null, { total: 600, type: 'takeaway' });
    expect(to).toEqual({ total: 600, type: 'takeaway' });
    expect(from).toEqual({});
  });
});
