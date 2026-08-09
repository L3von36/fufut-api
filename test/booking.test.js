import { describe, it, expect } from 'vitest';
import {
  parseTimeToMinutes,
  parseDate,
  computeWindow,
  normaliseDuration,
  windowsOverlap,
  holdsTable,
  blocksSeating,
  isLapsedNoShow,
  SHOP_UTC_OFFSET_MIN,
  DEFAULT_DURATION_MIN,
  GRACE_MIN,
} from '../src/lib/booking.js';

describe('parseTimeToMinutes', () => {
  it('reads 24-hour times', () => {
    expect(parseTimeToMinutes('18:30')).toBe(18 * 60 + 30);
    expect(parseTimeToMinutes('00:00')).toBe(0);
    expect(parseTimeToMinutes('23:59')).toBe(23 * 60 + 59);
  });

  // Production holds both formats in the same column, so both must parse.
  it('reads 12-hour times, including the midnight and noon edges', () => {
    expect(parseTimeToMinutes('7:00 AM')).toBe(7 * 60);
    expect(parseTimeToMinutes('7:00 PM')).toBe(19 * 60);
    expect(parseTimeToMinutes('12:00 AM')).toBe(0);
    expect(parseTimeToMinutes('12:30 PM')).toBe(12 * 60 + 30);
    expect(parseTimeToMinutes('12:15 am')).toBe(15);
  });

  it('rejects anything it cannot compare', () => {
    for (const bad of ['', null, undefined, 'lunchtime', '25:00', '10:75', '13:00 PM', 'noon', '7']) {
      expect(parseTimeToMinutes(bad)).toBeNull();
    }
  });
});

describe('parseDate', () => {
  it('accepts real dates', () => {
    expect(parseDate('2026-08-11')).toBe(Date.UTC(2026, 7, 11));
  });

  it('rejects dates that do not exist', () => {
    expect(parseDate('2026-02-31')).toBeNull();
    expect(parseDate('2026-13-01')).toBeNull();
    expect(parseDate('11/08/2026')).toBeNull();
    expect(parseDate('')).toBeNull();
  });
});

describe('computeWindow', () => {
  it('shifts local shop time to UTC', () => {
    // 18:30 in UTC+3 is 15:30 UTC.
    const w = computeWindow('2026-08-11', '18:30', 90);
    expect(w.startAt).toBe('2026-08-11T15:30:00.000Z');
    expect(w.endAt).toBe('2026-08-11T17:00:00.000Z');
    expect(w.durationMin).toBe(90);
  });

  it('uses the offset constant rather than assuming UTC', () => {
    const w = computeWindow('2026-08-11', '12:00', 60);
    const expected = new Date(Date.UTC(2026, 7, 11, 12, 0) - SHOP_UTC_OFFSET_MIN * 60000).toISOString();
    expect(w.startAt).toBe(expected);
  });

  it('crosses midnight UTC correctly for early local times', () => {
    // 01:00 local is 22:00 UTC the previous day.
    const w = computeWindow('2026-08-11', '01:00', 60);
    expect(w.startAt).toBe('2026-08-10T22:00:00.000Z');
  });

  it('defaults the duration when none is given', () => {
    expect(computeWindow('2026-08-11', '18:30').durationMin).toBe(DEFAULT_DURATION_MIN);
  });

  it('returns null when either part is unparseable', () => {
    expect(computeWindow('2026-08-11', 'whenever', 90)).toBeNull();
    expect(computeWindow('not-a-date', '18:30', 90)).toBeNull();
  });
});

describe('normaliseDuration', () => {
  it('defaults and clamps', () => {
    expect(normaliseDuration(undefined)).toBe(DEFAULT_DURATION_MIN);
    expect(normaliseDuration(0)).toBe(DEFAULT_DURATION_MIN);
    expect(normaliseDuration(-30)).toBe(DEFAULT_DURATION_MIN);
    expect(normaliseDuration('abc')).toBe(DEFAULT_DURATION_MIN);
    expect(normaliseDuration(5)).toBe(15);      // floor
    expect(normaliseDuration(5000)).toBe(720);  // ceiling
    expect(normaliseDuration(120)).toBe(120);
  });
});

describe('windowsOverlap', () => {
  const a = ['2026-08-11T15:00:00.000Z', '2026-08-11T16:30:00.000Z'];

  it('detects a genuine clash', () => {
    expect(windowsOverlap(a[0], a[1], '2026-08-11T16:00:00.000Z', '2026-08-11T17:30:00.000Z')).toBe(true);
  });

  it('detects containment in both directions', () => {
    expect(windowsOverlap(a[0], a[1], '2026-08-11T15:15:00.000Z', '2026-08-11T15:45:00.000Z')).toBe(true);
    expect(windowsOverlap('2026-08-11T15:15:00.000Z', '2026-08-11T15:45:00.000Z', a[0], a[1])).toBe(true);
  });

  // The most common real pattern: 18:00-19:30 then 19:30-21:00 on one table.
  it('allows back-to-back sittings that merely touch', () => {
    expect(windowsOverlap(a[0], a[1], '2026-08-11T16:30:00.000Z', '2026-08-11T18:00:00.000Z')).toBe(false);
    expect(windowsOverlap('2026-08-11T13:30:00.000Z', a[0], a[0], a[1])).toBe(false);
  });

  it('allows windows that do not touch at all', () => {
    expect(windowsOverlap(a[0], a[1], '2026-08-12T15:00:00.000Z', '2026-08-12T16:30:00.000Z')).toBe(false);
  });
});

describe('holdsTable / blocksSeating', () => {
  const start = '2026-08-11T15:00:00.000Z';
  const end = '2026-08-11T16:30:00.000Z';
  const base = { status: 'confirmed', start_at: start, end_at: end };
  const at = (iso) => Date.parse(iso);

  it('holds from before the booking until the window ends', () => {
    expect(holdsTable(base, at('2026-08-11T09:00:00.000Z'))).toBe(true);
    expect(holdsTable(base, at('2026-08-11T15:00:00.000Z'))).toBe(true);
  });

  it('still holds inside the grace period', () => {
    expect(holdsTable(base, at('2026-08-11T15:14:00.000Z'))).toBe(true);
  });

  it('lapses once the guest is later than the grace period', () => {
    // Exactly at the boundary it still holds; a minute past, it does not.
    expect(holdsTable(base, at('2026-08-11T15:15:00.000Z'))).toBe(true);
    expect(holdsTable(base, at('2026-08-11T15:16:00.000Z'))).toBe(false);
  });

  it('respects a custom grace period', () => {
    expect(holdsTable(base, at('2026-08-11T15:16:00.000Z'), 30)).toBe(true);
    expect(holdsTable(base, at('2026-08-11T15:31:00.000Z'), 30)).toBe(false);
  });

  it('does not hold after the window ends', () => {
    expect(holdsTable(base, at('2026-08-11T16:30:00.000Z'))).toBe(false);
  });

  it('does not hold once released, marked no-show, or cancelled', () => {
    expect(holdsTable({ ...base, released_at: '2026-08-11T14:00:00.000Z' }, at('2026-08-11T14:30:00.000Z'))).toBe(false);
    expect(holdsTable({ ...base, no_show_at: '2026-08-11T15:20:00.000Z' }, at('2026-08-11T15:05:00.000Z'))).toBe(false);
    expect(holdsTable({ ...base, status: 'cancelled' }, at('2026-08-11T14:30:00.000Z'))).toBe(false);
    expect(holdsTable({ ...base, status: 'completed' }, at('2026-08-11T14:30:00.000Z'))).toBe(false);
  });

  it('does not hold when the window is unparseable, rather than blocking forever', () => {
    expect(holdsTable({ ...base, start_at: null, end_at: null }, at('2026-08-11T14:30:00.000Z'))).toBe(false);
    expect(holdsTable({ ...base, start_at: '7:00 AM', end_at: '' }, at('2026-08-11T14:30:00.000Z'))).toBe(false);
  });

  it('blocksSeating agrees with holdsTable', () => {
    for (const t of ['2026-08-11T09:00:00.000Z', '2026-08-11T15:14:00.000Z', '2026-08-11T15:16:00.000Z']) {
      expect(blocksSeating(base, at(t))).toBe(holdsTable(base, at(t)));
    }
  });

  it('handles a missing reservation', () => {
    expect(holdsTable(null, Date.now())).toBe(false);
  });
});

describe('isLapsedNoShow', () => {
  const base = {
    status: 'confirmed',
    start_at: '2026-08-11T15:00:00.000Z',
    end_at: '2026-08-11T16:30:00.000Z',
  };

  it('is false before the grace period expires', () => {
    expect(isLapsedNoShow(base, Date.parse('2026-08-11T15:10:00.000Z'))).toBe(false);
  });

  it('is true once grace has expired and nobody marked it', () => {
    expect(isLapsedNoShow(base, Date.parse('2026-08-11T15:20:00.000Z'))).toBe(true);
  });

  it('is false for bookings already resolved', () => {
    const t = Date.parse('2026-08-11T15:20:00.000Z');
    expect(isLapsedNoShow({ ...base, no_show_at: 'x' }, t)).toBe(false);
    expect(isLapsedNoShow({ ...base, released_at: 'x' }, t)).toBe(false);
    expect(isLapsedNoShow({ ...base, status: 'cancelled' }, t)).toBe(false);
  });
});

describe('constants', () => {
  it('match the documented policy', () => {
    expect(SHOP_UTC_OFFSET_MIN).toBe(180); // Ethiopia, UTC+3, no DST
    expect(DEFAULT_DURATION_MIN).toBe(90);
    expect(GRACE_MIN).toBe(15);            // industry norm
  });
});
