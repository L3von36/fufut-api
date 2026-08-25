/**
 * The till's cash tally.
 *
 * A drawer's "expected" figure is opening float + cash sales − refunds, and
 * until now nothing ever wrote `cash_sales`: every birr taken in cash during a
 * shift surfaced at Z-count as unexplained variance. A cashier who counts
 * perfectly still showed +ETB whatever-they-sold, which teaches the floor that
 * variance is noise — exactly the lesson a till must never teach.
 *
 * Cash only. Telebirr, CBE, card and bank transfers never enter the drawer, so
 * they do not touch the tally. Cash tips are not folded in either: they are
 * owed to staff and paid out through the tips screen, not the till.
 *
 * Fail-open by design: a tally that fails must never fail the payment it
 * belongs to. The money moved; the record of it can be caught up. Errors are
 * logged and swallowed.
 */

import { d1Run } from './db.js';

/** Round to two decimals without float drift. */
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Add cash (negative to remove) to the newest open drawer.
 *
 * Returns the delta applied, or null when there is no open drawer or the write
 * failed. Sales taken with no drawer open are simply not attributed to a
 * shift — same as a shop that never opens a till.
 */
export async function addToOpenDrawerCash(env, amount) {
  const delta = round2(amount);
  if (!delta) return null;
  try {
    const { meta } = await d1Run(
      env,
      `UPDATE cashdrawers
          SET cash_sales = COALESCE(cash_sales, 0) + ?
        WHERE id = (
          SELECT id FROM cashdrawers WHERE status = 'open' ORDER BY created DESC LIMIT 1
        )`,
      [delta]
    );
    return meta && meta.changes ? delta : null;
  } catch (e) {
    console.error('[DRAWER] cash tally not updated:', e);
    return null;
  }
}
