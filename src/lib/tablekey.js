/**
 * The secret printed on a table's QR card.
 *
 * The code on the table has to say *which* table, and `?t=4` does that while
 * also letting anyone who can count place an order at any table from anywhere
 * in the world. The key is what makes the code identify a table rather than
 * merely name one.
 *
 * It is not a session and not a credential. It grants exactly one power:
 * attach an order to this table. Nobody signs in with it, it carries no role,
 * and it is useless for anything else.
 */

/**
 * Long enough that guessing is pointless, short enough to print on a card and
 * survive being read back over the phone. Ambiguous characters are left out —
 * a key nobody can transcribe is a support call every time a card is damaged.
 */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const LENGTH = 10;

export function generateTableKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(LENGTH));
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

/**
 * Compare without leaking how much of a guess was right.
 *
 * The same reasoning as the sync token: `===` returns as soon as it finds a
 * difference, and that timing is measurable across enough attempts. The keys
 * are short and the stakes are low, but constant-time comparison costs nothing
 * and removes the question.
 */
export function keysMatch(given, expected) {
  const a = String(given || '');
  const b = String(expected || '');
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The URL printed on the card.
 *
 * One code per table and never more. A table carrying separate codes for the
 * menu, for ordering and for paying is exactly where a counterfeit sticker
 * hides — among three, a fourth looks like it belongs. With a single known
 * code, anything extra is obviously wrong to staff and guests alike.
 */
export function tableOrderUrl(origin, table) {
  const base = String(origin || '').replace(/\/$/, '');
  return `${base}/order?t=${encodeURIComponent(table.id)}&k=${encodeURIComponent(table.qr_key)}`;
}
