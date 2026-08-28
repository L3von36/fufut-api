import { describe, it, expect } from 'vitest';
import {
  parseGuests,
  newReservationProblems,
  MAX_GUESTS,
  computeWindow,
} from '../src/lib/booking.js';

// The two clients this validation was written around:
//  - the public website posts {name, email, phone, date, time, guests, notes}
//    where guests is (was) the option label text and email is required;
//  - the POS posts {name, guests, date, time, tableNum, phone, durationMin}
//    where email does not exist and phone is optional.
// The junk this closes out: rows with no name, no time and no party size that
// QA tooling posted straight to the open endpoint.

describe('parseGuests', () => {
  it('reads plain numbers, truncating fractions', () => {
    expect(parseGuests(2)).toBe(2);
    expect(parseGuests(2.9)).toBe(2);
    expect(parseGuests(0)).toBe(0);
  });

  // What the website form actually sends: the option's label text.
  it('reads the leading integer out of label text', () => {
    expect(parseGuests('2 People')).toBe(2);
    expect(parseGuests('6+ People')).toBe(6);
    expect(parseGuests(' 3 ')).toBe(3);
    expect(parseGuests('12')).toBe(12);
  });

  it('refuses anything with no number in it', () => {
    expect(parseGuests('')).toBeNull();
    expect(parseGuests('   ')).toBeNull();
    expect(parseGuests('people')).toBeNull();
    expect(parseGuests(null)).toBeNull();
    expect(parseGuests(undefined)).toBeNull();
    expect(parseGuests(Number.NaN)).toBeNull();
  });
});

describe('newReservationProblems', () => {
  const futureStart = () => Date.parse(computeWindow('2030-01-01', '7:00 PM').startAt);
  const hourAgo = () => Date.now() - 60 * 60000;
  const now = () => Date.now();

  it('accepts the POS payload: name, numeric guests, no email, optional phone', () => {
    const data = { name: 'Wegene', guests: 4, date: '2030-01-01', time: '7:00 PM' };
    expect(newReservationProblems(data, futureStart(), now())).toEqual([]);
  });

  it('accepts the website payload: label-text guests, email, empty phone', () => {
    const data = {
      name: 'Amanuel', email: 'guest@example.com', phone: '',
      date: '2030-01-01', time: '1:00 PM', guests: '2 People', notes: 'window seat',
    };
    expect(newReservationProblems(data, futureStart(), now())).toEqual([]);
  });

  it('rejects the shape of junk found in production: no name, no party size', () => {
    const data = { date: '2030-01-01', time: '7:00 PM' };
    const problems = newReservationProblems(data, futureStart(), now());
    expect(problems).toContain('A guest name is required');
    expect(problems).toContain('A guest count is required');
  });

  it('caps the name at 100 characters', () => {
    const data = { name: 'x'.repeat(101), guests: 2 };
    expect(newReservationProblems(data, futureStart(), now())).toContain(
      'Guest name is limited to 100 characters'
    );
    expect(newReservationProblems({ name: 'x'.repeat(100), guests: 2 }, futureStart(), now())).toEqual([]);
  });

  it('bounds the party size', () => {
    expect(newReservationProblems({ name: 'A', guests: 0 }, futureStart(), now())).toContain(
      'Guests must be between 1 and ' + MAX_GUESTS
    );
    expect(newReservationProblems({ name: 'A', guests: MAX_GUESTS + 1 }, futureStart(), now())).toContain(
      'Guests must be between 1 and ' + MAX_GUESTS
    );
    expect(newReservationProblems({ name: 'A', guests: MAX_GUESTS }, futureStart(), now())).toEqual([]);
  });

  it('checks email only when one is sent, then checks it is an address', () => {
    expect(newReservationProblems({ name: 'A', guests: 2 }, futureStart(), now())).toEqual([]);
    expect(
      newReservationProblems({ name: 'A', guests: 2, email: 'not-an-address' }, futureStart(), now())
    ).toContain('Email address is not valid');
    expect(
      newReservationProblems({ name: 'A', guests: 2, email: 'a@b.co' }, futureStart(), now())
    ).toEqual([]);
  });

  it('caps phone and notes lengths', () => {
    expect(
      newReservationProblems({ name: 'A', guests: 2, phone: '0'.repeat(41) }, futureStart(), now())
    ).toContain('Phone is limited to 40 characters');
    expect(
      newReservationProblems({ name: 'A', guests: 2, notes: 'n'.repeat(501) }, futureStart(), now())
    ).toContain('Notes are limited to 500 characters');
  });

  it('refuses a booking for a time that has already gone by', () => {
    const data = { name: 'Late Guest', guests: 2 };
    expect(newReservationProblems(data, hourAgo(), now())).toContain(
      'Reservation time is in the past'
    );
  });

  it('still accepts a booking for right now, within the walk-in grace', () => {
    const data = { name: 'Walk-in', guests: 2 };
    const justNow = Date.now() - 10 * 60000;
    expect(newReservationProblems(data, justNow, now())).toEqual([]);
  });
});
