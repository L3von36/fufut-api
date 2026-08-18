/**
 * Is the venue actually there?
 *
 * Phase 4 of stages 4 and 5, and the locked decision behind it: **online
 * ordering is refused while the venue is offline.** Accepting a delivery order
 * the kitchen will never see is worse than telling the customer that ordering
 * is briefly closed. The customer can go elsewhere; a paid-for order nobody
 * cooks is a complaint and a refund.
 *
 * The box says it is alive by calling `/api/sync/status` every thirty seconds,
 * which stamps `venue_heartbeat`. Silence for long enough means the room cannot
 * see anything the cloud accepts.
 *
 * Two properties this has to have, and both are about failing in the right
 * direction:
 *
 * **Unconfigured means open.** If no box has ever checked in, there is no box —
 * the cloud is the only writer, exactly as it is today, and ordering must work
 * normally. Closing ordering because a machine that does not exist has not said
 * hello would take the website down the moment this code deployed.
 *
 * **A missed beat is not an outage.** The threshold is three intervals, not
 * one, so a single slow poll or a garbage-collection pause does not shut the
 * shop.
 */

import { d1Query } from './db.js';

/** Three missed 30-second heartbeats. */
export const OFFLINE_AFTER_MS = 90_000;

/**
 * `{ known, online, lastSeen }`.
 *
 * - `known: false` — no box has ever reported. Cloud-only operation; `online`
 *   is true because there is no room to be out of touch with.
 * - `online: false` — a box exists and has gone quiet.
 *
 * Never throws. A failure to read the heartbeat must not be the thing that
 * stops orders: if this cannot tell, it says the venue is up, because that is
 * how the system behaved before any of this existed.
 */
export async function venueStatus(env, nowMs = Date.now()) {
  try {
    const { results } = await d1Query(env, 'SELECT site_id, last_seen FROM venue_heartbeat ORDER BY last_seen DESC LIMIT 1');
    const row = results && results[0];
    if (!row || !row.last_seen) return { known: false, online: true, lastSeen: null };

    const seenMs = Date.parse(row.last_seen);
    if (!Number.isFinite(seenMs)) return { known: true, online: true, lastSeen: row.last_seen };

    return {
      known: true,
      online: nowMs - seenMs < OFFLINE_AFTER_MS,
      lastSeen: row.last_seen,
      siteId: row.site_id,
    };
  } catch {
    // The table does not exist yet, or the read failed. Either way this is not
    // grounds for refusing a customer's order.
    return { known: false, online: true, lastSeen: null };
  }
}

/**
 * Whether an anonymous order should be accepted right now.
 *
 * Deliberately only about *anonymous* orders. A signed-in member of staff
 * hitting the cloud is the fallback path when the box is down but the line is
 * up — refusing them would take the till offline at exactly the wrong moment,
 * which is the opposite of what this whole project is for.
 */
export async function onlineOrderingOpen(env, nowMs = Date.now()) {
  const status = await venueStatus(env, nowMs);
  return status.online;
}
