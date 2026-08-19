import { describe, it, expect } from 'vitest';
import {
  normaliseTableId,
  tableOverstayed,
  ticketStale,
  msSince,
  DEFAULT_TABLE_MAX_HOURS,
  DEFAULT_KITCHEN_STALE_HOURS,
} from '../src/lib/staleness.js';

const HOUR = 3600000;
const NOW = Date.parse('2026-08-18T18:00:00.000Z');
const agoIso = (hours) => new Date(NOW - hours * HOUR).toISOString();

/**
 * Production held "3", "03", "7" and "7.0" for what are references to two
 * tables. Every screen compares this as a string, so an order written "7.0"
 * belongs to no table at all: no open-tab badge, and Add Round cannot find it.
 */
describe('normaliseTableId', () => {
  it('collapses the numeric spellings of one table onto each other', () => {
    expect(normaliseTableId('7.0')).toBe('7');
    expect(normaliseTableId('07')).toBe('7');
    expect(normaliseTableId('7')).toBe('7');
    expect(normaliseTableId(7)).toBe('7');
    expect(normaliseTableId(' 7 ')).toBe('7');
  });

  it('collapses the prefixed spellings onto the same table', () => {
    // `tables.id` is free text: "T6" in the seeded rows, "Table 6" in the
    // live ones. A QR order was filed under the raw id and a POS order under
    // the number, so the floor plan showed nothing against the table.
    for (const v of ['T6', 't6', 'Table 6', 'table 6', 'TABLE 6',
                     'Table-6', 'Table_6', 'Table.6', 'tbl 6', ' Table 6 ']) {
      expect(normaliseTableId(v)).toBe('6');
    }
    expect(normaliseTableId('Table 12')).toBe('12');
    expect(normaliseTableId('TABLE 03')).toBe('3');
  });

  it('leaves a table that is not a plain number exactly as typed', () => {
    expect(normaliseTableId('A1')).toBe('A1');
    expect(normaliseTableId('Patio 2')).toBe('Patio 2');
    // Not a whole number, so not ours to reinterpret.
    expect(normaliseTableId('2.5')).toBe('2.5');
    // A prefix is only a prefix when a number follows it. These are names,
    // and collapsing them would merge two real tables into one.
    expect(normaliseTableId('T')).toBe('T');
    expect(normaliseTableId('Table')).toBe('Table');
    expect(normaliseTableId('Table A')).toBe('Table A');
    expect(normaliseTableId('Takeaway')).toBe('Takeaway');
    expect(normaliseTableId('Terrace')).toBe('Terrace');
  });

  it('treats blank and missing as no table', () => {
    for (const v of ['', '   ', null, undefined]) expect(normaliseTableId(v)).toBeNull();
  });
});

describe('tableOverstayed', () => {
  const occupied = (seatedHoursAgo) => ({ status: 'occupied', seated_at: agoIso(seatedHoursAgo) });

  it('leaves a table that is within a normal sitting', () => {
    expect(tableOverstayed(occupied(1), NOW)).toBe(false);
    expect(tableOverstayed(occupied(DEFAULT_TABLE_MAX_HOURS - 0.5), NOW)).toBe(false);
  });

  it('flags one held far longer than anybody sits', () => {
    expect(tableOverstayed(occupied(DEFAULT_TABLE_MAX_HOURS + 1), NOW)).toBe(true);
    // The case from production: seated four days earlier and never cleared.
    expect(tableOverstayed(occupied(96), NOW)).toBe(true);
  });

  it('only judges tables that are actually occupied', () => {
    for (const status of ['available', 'cleaning', 'reserved']) {
      expect(tableOverstayed({ status, seated_at: agoIso(96) }, NOW)).toBe(false);
    }
  });

  /**
   * Production has one. Guessing an age would either free a live table or
   * never free a dead one, so the sweep stamps it instead and it starts
   * ageing from when it was noticed.
   */
  it('refuses to age a table with no seating stamp', () => {
    expect(tableOverstayed({ status: 'occupied', seated_at: '' }, NOW)).toBe(false);
    expect(tableOverstayed({ status: 'occupied', seated_at: null }, NOW)).toBe(false);
    expect(tableOverstayed({ status: 'occupied', seated_at: 'not a date' }, NOW)).toBe(false);
  });

  it('honours a venue that turns its tables faster', () => {
    expect(tableOverstayed(occupied(1.5), NOW, 1)).toBe(true);
    expect(tableOverstayed(occupied(1.5), NOW, 3)).toBe(false);
  });
});

describe('ticketStale', () => {
  it('keeps a ticket the kitchen is plausibly still cooking', () => {
    // The board already calls 15 minutes critical; this is not that alarm.
    expect(ticketStale({ created: agoIso(0.25) }, NOW)).toBe(false);
    expect(ticketStale({ created: agoIso(DEFAULT_KITCHEN_STALE_HOURS - 0.5) }, NOW)).toBe(false);
  });

  it('drops one nobody was ever going to cook', () => {
    expect(ticketStale({ created: agoIso(DEFAULT_KITCHEN_STALE_HOURS + 1) }, NOW)).toBe(true);
    // The oldest still sitting on the live board: three weeks.
    expect(ticketStale({ created: agoIso(24 * 18) }, NOW)).toBe(true);
  });

  it('keeps a ticket whose creation time cannot be read, rather than hiding it', () => {
    expect(ticketStale({ created: '' }, NOW)).toBe(false);
    expect(ticketStale({}, NOW)).toBe(false);
    expect(ticketStale(null, NOW)).toBe(false);
  });

  it('reads the space-separated stamps production actually stores', () => {
    // Rows hold both "2026-08-14 12:33:38" and "2026-07-31T04:55".
    expect(msSince('2026-08-18 17:00:00', NOW)).not.toBeNull();
    expect(msSince('2026-08-18T17:00:00Z', NOW)).toBe(HOUR);
  });
});
