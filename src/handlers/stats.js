/**
 * The public counters on the website — real numbers, straight from the
 * trading data.
 *
 * "48K+ happy customers, 620,000 cups served" were marketing figures typed
 * into the HTML in 2026 and never moved again. This endpoint replaces them
 * with what the database actually holds, so the numbers grow as the venue
 * trades — and because the site polls it, they move during service rather
 * than at the next deploy.
 *
 * What each number is, honestly:
 *
 * - happyCustomers — non-voided orders taken. An order is a party of guests,
 *   which is the closest real thing to a "customer" the till records.
 * - cupsServed — quantity of beverage line items (Coffee / Drinks) across
 *   non-voided orders. Food is not a cup.
 * - yearsServing — this year minus `venue.founded_year`. Tick-over is
 *   automatic; the setting is the only input.
 * - awards, coffeeOrigins, happyPercent — external/brand facts the till cannot
 *   count (a roaster list is not an order line; satisfaction is not a column).
 *   Each stays curated in settings (`stats.awards`, `stats.coffee_origins`,
 *   `stats.happy_percent`) rather than in HTML, so changing one is a setting,
 *   not a deploy. The website matches values to slots by these keys — never
 *   by position — so adding a metric here cannot put an order count under the
 *   "Happy Percent" label again.
 *
 * The two counts can be topped up with a pre-POS baseline
 * (`stats.baseline_customers`, `stats.baseline_cups`) so the venue's real
 * history before the system existed is not erased by switching it on.
 */

import { d1Query, json } from '../lib/db.js';

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Read the stats-related settings as a plain key/value map, JSON-parsed. */
async function statsSettings(env) {
  try {
    const { results } = await d1Query(
      env,
      "SELECT key, value FROM settings WHERE key LIKE 'stats.%' OR key = 'venue.founded_year'"
    );
    const map = {};
    for (const row of results || []) {
      try { map[row.key] = JSON.parse(row.value); } catch { map[row.key] = row.value; }
    }
    return map;
  } catch {
    // Before the settings table exists, defaults carry the endpoint.
    return {};
  }
}

export async function handlePublicStats(env) {
  const settings = await statsSettings(env);

  // Which menu categories count as a cup. A setting rather than a constant,
  // so adding a "Juice" category is a setting change, not a deploy.
  const cupCategories = String(settings['stats.cup_categories'] || 'coffee,drinks')
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
  const placeholders = cupCategories.map(() => '?').join(', ');

  const [ordersAgg, cupsAgg] = await Promise.all([
    d1Query(env, 'SELECT COUNT(*) AS n FROM orders WHERE voided_at IS NULL'),
    placeholders
      ? d1Query(
          env,
          `SELECT COALESCE(SUM(oi.qty), 0) AS cups
             FROM order_items oi
             JOIN orders o ON o.id = oi.order_id
            WHERE o.voided_at IS NULL
              AND LOWER(COALESCE(oi.category, '')) IN (${placeholders})`,
          cupCategories
        )
      : Promise.resolve({ results: [{ cups: 0 }] }),
  ]);

  const ordersCount = Number(ordersAgg.results?.[0]?.n) || 0;
  const cupsCount = Number(cupsAgg.results?.[0]?.cups) || 0;
  const foundedYear = num(settings['venue.founded_year'], 2017);

  return json({
    ok: true,
    happyCustomers: ordersCount + Math.max(0, Math.round(num(settings['stats.baseline_customers'], 0))),
    cupsServed: cupsCount + Math.max(0, Math.round(num(settings['stats.baseline_cups'], 0))),
    yearsServing: Math.max(0, new Date().getFullYear() - foundedYear),
    awards: Math.max(0, Math.round(num(settings['stats.awards'], 14))),
    coffeeOrigins: Math.max(0, Math.round(num(settings['stats.coffee_origins'], 3))),
    happyPercent: Math.min(100, Math.max(0, Math.round(num(settings['stats.happy_percent'], 99)))),
  });
}
