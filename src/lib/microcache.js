/**
 * A tiny per-isolate response cache for the hot poll endpoints.
 *
 * The POS is a fleet of tablets all polling the same few lists — /api/alerts
 * on every screen's banner, /api/tables on the floor plan and the cashier's
 * dashboard, /api/orders on the kitchen boards, /api/stats on the dashboard.
 * Each poll lands on D1, the reads multiply by device count, and the free
 * tier's daily row-read budget dies somewhere around the lunch rush — which
 * is exactly what happened on 2026-09-04 (5.29M rows read by 12:00 UTC, then
 * hard 500s until midnight).
 *
 * The cache coalesces those bursts: devices polling within each other's TTL
 * share one upstream response. A role key is part of every cache key because
 * /api/alerts answers differently per role — a chef's open-alerts list must
 * never become a cashier's.
 *
 * Correctness contract:
 *   - only successful (200) JSON responses from the whitelisted exact paths
 *     are cached, and only for seconds, not minutes;
 *   - ANY successful non-GET request flushes the whole cache. Writes are rare
 *     next to polls, so a blunt flush costs nothing and removes every
 *     read-after-write staleness question;
 *   - the TTLs are shorter than the screens' own poll intervals, so a user
 *     cannot observe the cache doing anything at all.
 */

const MAX_ENTRIES = 256;
const cache = new Map(); // key → { at, status, body, contentType }

export const CACHE_TTL = {
  '/api/alerts': 4000, // banner + dashboard poll at 60s; SSE pushes within 10s
  '/api/tables': 3000, // floor plan, bill-request card, payment summary
  '/api/orders': 3000, // kitchen boards (their SSE covers live updates)
  '/api/stats': 15000, // dashboard aggregates, polled at 30-60s
  // The manager dashboard loads eleven shared lists in one burst, and two
  // managers opening it at once used to be two full bursts. These are all
  // role-shared collections — no per-person shape — so one cache entry per
  // role+query is safe. Deliberately NOT here: anything per-user
  // (timeclock/me, cashdrawer/shift-log) — the cache key carries the ROLE,
  // not the staff id, and a shared key there would show one person's shift
  // to another.
  '/api/payments': 5000,
  '/api/tips': 5000,
  '/api/expenses': 5000,
  '/api/inventory': 5000,
  '/api/waste': 5000,
  '/api/delivery': 5000,
  '/api/reservations': 5000,
};

export function microCacheKey(roleKey, pathname, search) {
  return `${roleKey}|${pathname}|${search}`;
}

/** A fresh cached response for this key, or null. */
export function microCacheGet(key, ttlMs) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at >= ttlMs) {
    cache.delete(key);
    return null;
  }
  // Refresh recency so pruning drops the cold keys first.
  entry.at = Date.now();
  return { status: entry.status, body: entry.body, contentType: entry.contentType };
}

export function microCachePut(key, status, body, contentType) {
  if (cache.size >= MAX_ENTRIES) {
    // Drop the oldest entry (Map preserves insertion order; the recency
    // refresh above re-inserts hot keys, so the tail is genuinely cold).
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), status, body, contentType });
}

/** Drop everything. Called after any successful write — see the contract. */
export function microCacheFlush() {
  cache.clear();
}

/** True when this exact path is one of the whitelisted poll endpoints. */
export function cacheablePath(pathname) {
  return Object.prototype.hasOwnProperty.call(CACHE_TTL, pathname);
}
