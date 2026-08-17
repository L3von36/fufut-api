import { describe, it, expect } from 'vitest';
import { isNewSeating } from '../src/lib/booking.js';

/**
 * Table exclusivity: one party at a time.
 *
 * The API cannot tell "seat a new party" from "edit the party already sitting
 * there" by the verb alone — both are PUT {status:'occupied'}. `seated_at` is
 * what separates them, and getting that wrong breaks in one of two directions:
 * refuse every edit to a seated table, or never refuse a second party.
 */
describe('isNewSeating', () => {
  const free = { status: 'available', seated_at: '' };
  const seated = { status: 'occupied', seated_at: '2026-08-17T18:40:00.000Z' };

  it('treats seating a free table as new', () => {
    expect(isNewSeating(free, '2026-08-17T19:00:00.000Z')).toBe(true);
    expect(isNewSeating(free, '')).toBe(true);
  });

  it('treats a table with no row as new', () => {
    expect(isNewSeating(null, '2026-08-17T19:00:00.000Z')).toBe(true);
  });

  // The floor plan sends the whole row back when a waiter edits guest count or
  // server on a table that is already seated. That must not read as a second
  // party arriving.
  it('treats an edit carrying the same seated_at as the same party', () => {
    expect(isNewSeating(seated, '2026-08-17T18:40:00.000Z')).toBe(false);
    expect(isNewSeating(seated, ' 2026-08-17T18:40:00.000Z ')).toBe(false);
  });

  // This is the case the whole feature exists for: a second waiter, on a second
  // tablet, sending their own fresh timestamp for a table someone is sitting at.
  it('treats a different seated_at on an occupied table as a new party', () => {
    expect(isNewSeating(seated, '2026-08-17T19:05:00.000Z')).toBe(true);
  });

  it('treats a missing seated_at on an occupied table as a new party', () => {
    expect(isNewSeating(seated, '')).toBe(true);
    expect(isNewSeating(seated, undefined)).toBe(true);
  });

  // A row left occupied with no timestamp cannot identify its own seating, so
  // there is nothing to protect and the next party may take it. Refusing here
  // would strand the table with no way back except a manager.
  it('lets a party take an occupied table that carries no seating stamp', () => {
    expect(isNewSeating({ status: 'occupied', seated_at: '' }, '2026-08-17T19:00:00.000Z')).toBe(true);
    expect(isNewSeating({ status: 'occupied', seated_at: null }, '2026-08-17T19:00:00.000Z')).toBe(true);
  });

  it('ignores case in the stored status', () => {
    expect(isNewSeating({ status: 'Occupied', seated_at: 'x' }, 'x')).toBe(false);
  });

  // Cleaning and reserved are not seating: a party may take the table, and the
  // reservation gate is what decides whether they may, not this function.
  it('treats non-occupied statuses as free to seat', () => {
    for (const status of ['available', 'cleaning', 'reserved']) {
      expect(isNewSeating({ status, seated_at: 'x' }, 'y')).toBe(true);
    }
  });
});
