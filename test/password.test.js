import { describe, it, expect } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  sha256,
  isLegacyHash,
  generateTempPassword,
  passwordProblem,
  PBKDF2_ITERATIONS,
} from '../src/lib/crypto.js';

/** Build a hash in the old format, to prove it still verifies. */
async function legacyHash(password, salt = 'abc123') {
  return `${salt}:${await sha256(password + salt)}`;
}

describe('hashPassword', () => {
  it('produces the stretched format', async () => {
    const h = await hashPassword('correct horse 9');
    expect(h.startsWith(`pbkdf2$${PBKDF2_ITERATIONS}$`)).toBe(true);
    expect(h.split('$')).toHaveLength(4);
  });

  it('salts, so the same password never yields the same hash twice', async () => {
    const [a, b] = await Promise.all([hashPassword('same pw 1'), hashPassword('same pw 1')]);
    expect(a).not.toBe(b);
  });

  it('round-trips', async () => {
    const h = await hashPassword('correct horse 9');
    expect(await verifyPassword('correct horse 9', h)).toBe(true);
    expect(await verifyPassword('wrong horse 9', h)).toBe(false);
  });

  it('uses an iteration count worth having', () => {
    expect(PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(100000);
  });
});

describe('verifyPassword', () => {
  // Existing rows are all in the old format; refusing them would lock out the
  // entire business.
  it('still accepts the legacy unstretched format', async () => {
    const h = await legacyHash('fufut2026');
    expect(await verifyPassword('fufut2026', h)).toBe(true);
    expect(await verifyPassword('nope', h)).toBe(false);
  });

  it('handles both formats without confusing them', async () => {
    const legacy = await legacyHash('shared pw');
    const modern = await hashPassword('shared pw');
    expect(await verifyPassword('shared pw', legacy)).toBe(true);
    expect(await verifyPassword('shared pw', modern)).toBe(true);
  });

  it('refuses anything malformed rather than throwing', async () => {
    for (const bad of [null, undefined, '', 'garbage', 'pbkdf2$$$', 'pbkdf2$notanumber$s$h', ':', 42]) {
      expect(await verifyPassword('x', bad)).toBe(false);
    }
  });
});

describe('isLegacyHash', () => {
  it('identifies which hashes need upgrading', async () => {
    expect(isLegacyHash(await legacyHash('x'))).toBe(true);
    expect(isLegacyHash(await hashPassword('x0000000'))).toBe(false);
    expect(isLegacyHash(null)).toBe(false);
    expect(isLegacyHash('no-separator')).toBe(false);
  });
});

describe('generateTempPassword', () => {
  it('is different every time', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateTempPassword()));
    expect(seen.size).toBe(50);
  });

  it('avoids characters that are misread when handed over verbally', () => {
    for (let i = 0; i < 40; i++) {
      // No 0/O/1/l/I, which are the ones people transcribe wrongly.
      expect(generateTempPassword()).not.toMatch(/[0O1lI]/);
    }
  });

  it('is long enough to be worth generating', () => {
    expect(generateTempPassword().length).toBeGreaterThanOrEqual(10);
  });

  // The whole point: "reset to default" is how one password ends up shared.
  it('is never a fixed default', () => {
    expect(generateTempPassword()).not.toBe(generateTempPassword());
  });
});

describe('passwordProblem', () => {
  it('accepts something reasonable', () => {
    expect(passwordProblem('kitchen42')).toBeNull();
  });

  it('rejects short, letter-only, digit-only and non-strings', () => {
    expect(passwordProblem('abc12')).toMatch(/8 characters/);
    expect(passwordProblem('allletters')).toMatch(/letter and one number/);
    expect(passwordProblem('12345678')).toMatch(/letter and one number/);
    expect(passwordProblem(null)).toMatch(/8 characters/);
    expect(passwordProblem(12345678)).toMatch(/8 characters/);
  });

  it('rejects an absurdly long password rather than hashing it', () => {
    expect(passwordProblem('a1'.repeat(200))).toMatch(/too long/);
  });

  // The password every account currently shares must not survive a change.
  it('would reject nothing about the current shared password, which is why the flag matters', () => {
    // fufut2026 is 9 chars with letters and digits, so it passes the format
    // check. Strength rules alone would never have caught it - only forcing a
    // change does.
    expect(passwordProblem('fufut2026')).toBeNull();
  });
});
