/**
 * FU FUT COFFEE — API Worker
 *
 * Serves both the POS (pos.fufutcoffee.com, via a same-origin Pages proxy) and
 * the public website (fufutcoffee.com).
 *
 * This is a source reconstruction of the deployed build. Every handler body was
 * lifted verbatim from the deployed bundle and split into modules, so runtime
 * behaviour is unchanged. The genuinely new code is the authorization gate in
 * ./auth.js and its two call sites below.
 *
 * Route order below intentionally mirrors the original dispatcher exactly —
 * several handlers return null to fall through to the next, so reordering them
 * changes behaviour.
 */

import { json } from './lib/db.js';
import { authorize, redactStaffForRole } from './auth.js';
import {
  getModeSync,
  quotaTick,
  cacheTtlMultiplier,
  cronShouldSweep,
} from './lib/quota.js';
import { handleHealth, handleHealthMode } from './handlers/health.js';
import {
  CACHE_TTL,
  cacheablePath,
  microCacheGet,
  microCacheKey,
  microCachePut,
  microCacheFlush,
} from './lib/microcache.js';

import { handleContent, checkScheduledPublish } from './handlers/content.js';
import { handleOrders, loadStaleHours, autoCompleteStaleOrders } from './handlers/orders.js';
import { handleAlerts, runAlertSweep } from './handlers/alerts.js';
import { handlePayments } from './handlers/payments.js';
import { handleAudit } from './handlers/audit.js';
import { handleDelivery } from './handlers/delivery.js';
import { handleRecipes } from './handlers/recipes.js';
import { handleInventory, handleWaste } from './handlers/inventory.js';
import { handlePurchases } from './handlers/purchases.js';
import { handleHR } from './handlers/hr.js';
import { handleReports } from './handlers/reports.js';
import { handleReservations } from './handlers/reservations.js';
import { handleReviews } from './handlers/reviews.js';
import { handleMenu } from './handlers/menu.js';
import { handleGallery } from './handlers/gallery.js';
import { handleUpload } from './handlers/upload.js';
import { handleMigration } from './handlers/migration.js';
import { handleResources } from './handlers/resources.js';
import { handleRoleScopes } from './handlers/role-scopes.js';
import { handleTables, releaseOverstayedTables } from './handlers/tables.js';
import { handleStaff } from './handlers/staff.js';
import { handlePublicStats } from './handlers/stats.js';
import { handleCustomers } from './handlers/customers.js';
import { handleSSE } from './handlers/sse.js';
import { handleSync } from './handlers/sync.js';
import { venueStatus } from './lib/venue.js';
import {
  handleStaffLogin,
  handleSessionCheck,
  handleLogout,
  handleResetPassword,
  handleChangePassword,
} from './handlers/session.js';

const CORS_PREFLIGHT = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
  // The website (fufutcoffee.com) is a different origin from the API: without
  // this the X-Fufut-Mode degradation hint is invisible to its JS.
  'Access-Control-Expose-Headers': 'X-Fufut-Mode',
};

async function serveImage(env, pathname) {
  const key = decodeURIComponent(pathname.replace('/api/images/', ''));
  if (!key) return json({ ok: false, error: 'No image key' }, 400);
  try {
    const object = await env.IMAGES_R2.get(key);
    if (!object) return json({ ok: false, error: 'Not found' }, 404);
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('Cache-Control', 'public, max-age=86400');
    headers.set('ETag', object.httpEtag);
    return new Response(object.body, { headers });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
}

/** Dispatch to the original handlers, in the original order. */
async function route(pathname, method, url, request, env, ctx, auth) {
  const upper = method.toUpperCase();

  // Liveness + quota mode. Reads no D1 (see handlers/health.js) — deliberately
  // first, before anything that might touch the database that may be down.
  if (pathname === '/api/health' && upper === 'GET') return handleHealth(request, env);
  if (pathname === '/api/health/mode' && upper === 'POST') return handleHealthMode(request, env);

  if (pathname === '/api/auth/login' && upper === 'POST') return handleStaffLogin(request, env);
  if (pathname === '/api/auth/me' && upper === 'GET') return handleSessionCheck(request, env);
  if (pathname === '/api/auth/logout' && upper === 'POST') return handleLogout(request, env);
  if (pathname === '/api/auth/reset-password' && upper === 'POST') return handleResetPassword(request, env);
  if (pathname === '/api/auth/change-password' && upper === 'POST') return handleChangePassword(request, env);
  if (pathname === '/api/upload' && upper === 'POST') return handleUpload(request, env);
  if (pathname.startsWith('/api/images/') && upper === 'GET') return serveImage(env, pathname);

  if (pathname === '/api/payments/proxy' && upper === 'GET') {
    const targetUrl = url.searchParams.get('url');
    if (!targetUrl) return json({ ok: false, error: 'URL required' }, 400);
    try {
      const res = await fetch(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
      const contentType = res.headers.get('Content-Type') || 'application/octet-stream';
      const body = await res.arrayBuffer();
      return new Response(body, { headers: { 'Content-Type': contentType } });
    } catch (e) {
      return json({ ok: false, error: String(e) }, 500);
    }
  }

  const migration = await handleMigration(request, env);
  if (migration !== null) return migration;

  const content = await handleContent(pathname, method, url, request, env);
  if (content !== null) return content;

  if (pathname === '/api/stats' && upper === 'GET') {
    return handlePublicStats(env);
  }

  if (pathname === '/api/events/tables' || pathname === '/api/events/kitchen' || pathname === '/api/events/alerts' || pathname === '/api/events/activity') {
    const channel = pathname.endsWith('tables') ? 'tables' : pathname.endsWith('alerts') ? 'alerts' : pathname.endsWith('activity') ? 'activity' : 'kitchen';
    return handleSSE(request, env, channel, auth);
  }

  // Sync between the box and the cloud. Authorised in auth.js — the three
  // machine routes by SYNC_TOKEN, the reconciliation list by a manager session.
  if (pathname.startsWith('/api/sync/')) {
    return handleSync(pathname, method, url, request, env, auth);
  }

  /**
   * Public: can the venue actually take an order right now?
   *
   * The website reads this to close its ordering UI before a customer fills a
   * basket, rather than letting them reach checkout and be refused. The refusal
   * itself lives on POST /api/orders — this is the courtesy, that is the
   * guarantee.
   */
  if (pathname === '/api/venue/status' && upper === 'GET') {
    const venue = await venueStatus(env);
    return json({
      ok: true,
      online_ordering: venue.online,
      venue_online: venue.online,
      last_seen: venue.lastSeen,
    });
  }

  if (pathname.startsWith('/api/orders')) {
    const r = await handleOrders(pathname, method, url, request, env, ctx, auth);
    if (r !== null) return r;
  }
  // Payments and tips are separate resources from orders on purpose: a waiter
  // may take an order and may not verify a bank transfer, and a tip is not
  // revenue. Gated independently in the role matrix for both reasons.
  if (pathname.startsWith('/api/payments') || pathname.startsWith('/api/tips')) {
    const r = await handlePayments(pathname, method, url, request, env, ctx, auth);
    if (r !== null) return r;
  }
  if (pathname.startsWith('/api/audit')) {
    const r = await handleAudit(pathname, method, url, env, auth);
    if (r !== null) return r;
  }
  if (pathname.startsWith('/api/reservations')) {
    const r = await handleReservations(pathname, method, request, env, auth);
    if (r !== null) return r;
  }
  if (pathname.startsWith('/api/reviews')) {
    const r = await handleReviews(pathname, method, request, env);
    if (r !== null) return r;
  }
  if (pathname.startsWith('/api/customers')) {
    const r = await handleCustomers(pathname, method, url, request, env, auth);
    if (r !== null) return r;
  }

  // Alerts read their own resource: the rules the sweep writes are what the
  // floor acts on. Gated per role below, in the matrix.
  const alerts = await handleAlerts(pathname, method, url, request, env, auth);
  if (alerts !== null) return alerts;

  // Must precede handleResources: it enriches GET /api/tables with the current
  // reservation hold, and gates seating a reserved table. It returns null to
  // fall through whenever the generic handler should do the actual write.
  const tables = await handleTables(pathname, method, url, request, env, auth);
  if (tables !== null) return tables;

  // HR and reporting have no generic-resource equivalent. Both must precede
  // handleResources only in the sense that they own paths it does not map;
  // ordering here is for readability.
  const hr = await handleHR(pathname, method, url, request, env, auth);
  if (hr !== null) return hr;

  const reports = await handleReports(pathname, method, url, request, env, auth);
  if (reports !== null) return reports;

  // Recipes and the unit catalogue have no generic-resource equivalent, so
  // order relative to it does not matter.
  const recipes = await handleRecipes(pathname, method, url, request, env, auth);
  if (recipes !== null) return recipes;

  // Must precede handleResources: it owns every route that changes a *quantity*,
  // and specifically intercepts the direct write to `stock` that used to
  // overwrite the previous value with no record. Catalogue edits — renaming,
  // recategorising, setting a reorder point — return null and fall through.
  const inventory = await handleInventory(pathname, method, url, request, env, auth);
  if (inventory !== null) return inventory;

  // Must precede handleResources: waste that names a real ingredient now takes
  // it off the shelf as well as logging it. Free-text legacy waste returns null
  // and falls through, so the existing screen keeps working unchanged.
  const waste = await handleWaste(pathname, method, request, env, auth);
  if (waste !== null) return waste;

  // Must precede handleResources for suppliers: the list is enriched with each
  // supplier's outstanding balance, which the generic handler cannot compute.
  const purchases = await handlePurchases(pathname, method, url, request, env, auth);
  if (purchases !== null) return purchases;

  // Must precede handleResources: it owns the delivery state machine and the
  // driver's settlement with the cashier. Plain edits to address, phone and eta
  // return null and fall through to the generic handler, which already does
  // those correctly.
  const delivery = await handleDelivery(pathname, method, url, request, env, auth);
  if (delivery !== null) return delivery;

  // Must precede handleResources: that handler writes any column it is given,
  // so a request carrying password_hash would set it directly. Creation and
  // editing of staff are handled here; GET and DELETE fall through.
  const staff = await handleStaff(pathname, method, request, env);
  if (staff !== null) return staff;

  // The manager's permission-granter (Role Access page). Manager-only via
  // MANAGER_ONLY in auth.js; must precede handleResources, which would 404 the
  // path as an unknown resource table.
  const roleScopes = await handleRoleScopes(pathname, method, url, request, env, auth);
  if (roleScopes !== null) return roleScopes;

  const resources = await handleResources(pathname, method, url, request, env);
  if (resources !== null) return resources;

  const menu = await handleMenu(pathname, method, request, env, ctx, auth);
  if (menu !== null) return menu;

  const gallery = await handleGallery(pathname, method, request, env, ctx);
  if (gallery !== null) return gallery;

  return json({ ok: false, error: 'Not found' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_PREFLIGHT });
    }

    // ── Quota circuit breaker (lib/quota.js) ────────────────────────────
    // Lazy maintenance: refresh the KV day-total view (≤1 read/min/isolate)
    // and flush this isolate's exact row count (≤1 write/5min/isolate). Both
    // draw on KV's separate quota and neither ever throws into the request.
    try {
      quotaTick(env, ctx);
    } catch {
      // Bookkeeping must never break a request.
    }
    const mode = getModeSync();

    // Shed the expensive convenience reads BEFORE they touch D1 once the day
    // is nearly spent: reports are on-demand manager analytics, exactly what
    // the breaker's contract says goes first. Everything the POS needs to
    // trade — login, orders, payments, tables, the live boards — is never
    // gated here. Answered ahead of the auth gate so a dying database does
    // zero work: 503 with a Retry-After, no session lookup, no query.
    if (
      mode === 'critical' &&
      method.toUpperCase() === 'GET' &&
      pathname.startsWith('/api/reports')
    ) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: 'Daily data budget nearly exhausted — reports are paused and will return at 00:00 UTC',
          mode,
          resets_at_utc: '00:00',
        }),
        { status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '300' } }
      );
    }

    // ── Authorization gate ──────────────────────────────────────────────
    const decision = await authorize(request, env, pathname, method.toUpperCase(), url);
    if (!decision.ok) return decision.response;

    // ── Poll coalescing (see lib/microcache.js) ─────────────────────────
    // Only exact whitelisted paths, only GET, keyed by role + query string.
    // The lookup sits AFTER the authorization gate: the cache can only ever
    // answer for a session that would have been allowed to make the call.
    const isGet = method.toUpperCase() === 'GET';
    const roleKey = String(
      (decision.auth && (decision.auth.sessionRole || decision.auth.role)) || 'anon'
    ).toLowerCase();
    // TTLs stretch as the budget drains (x3 conserve, x8 emergency) — the
    // same coalescing doing proportionally more work with less headroom.
    const cacheKey =
      isGet && cacheablePath(pathname)
        ? microCacheKey(roleKey, pathname, url.search)
        : null;
    if (cacheKey) {
      const hit = microCacheGet(cacheKey, CACHE_TTL[pathname] * cacheTtlMultiplier(mode));
      if (hit) {
        return new Response(hit.body, {
          status: hit.status,
          headers: { 'Content-Type': hit.contentType },
        });
      }
    }

    let response;
    try {
      response = await route(pathname, method, url, request, env, ctx, decision.auth);
    } catch (e) {
      // The outage of 2026-09-04 surfaced to staff as the raw text
      // "error code: 1101" — an unhandled Worker exception with no status
      // contract the clients could parse. Whatever escapes a handler now
      // leaves as JSON, so the POS sees a normal error shape it can show,
      // queue offline, or retry — and the logs keep the stack via console.
      console.error('[API] unhandled error on', method, pathname, e);
      response = json(
        { ok: false, error: 'Internal error', detail: String((e && e.message) || e).slice(0, 200) },
        500
      );
    }

    // A successful write invalidates every cached read: the writer's very
    // next read must see what they just did, and 3-15s TTLs are short enough
    // that a blunt flush costs nothing. Failed writes change nothing.
    if (!isGet && response && response.status >= 200 && response.status < 300) {
      microCacheFlush();
    }

    // Cache the poll endpoints' 200 JSON answers. Bodies are read as text so
    // the cached copy is a plain string — safe to hand to many Responses.
    if (cacheKey && response && response.status === 200) {
      try {
        const body = await response.clone().text();
        const contentType = response.headers.get('Content-Type') || 'application/json';
        microCachePut(cacheKey, response.status, body, contentType);
      } catch {
        // A body that cannot be cloned is simply not cached.
      }
    }

    // Tell every client which degradation mode the API is in — the POS can
    // surface "live updates slowed to conserve quota" without a new endpoint.
    try {
      response.headers.set('X-Fufut-Mode', mode);
    } catch {
      // An immutable-headers response is simply returned without the hint.
    }

    // Staff listings carry colleague phone numbers and emails. Time Clock and
    // Shifts need names, so redact contact details rather than blocking.
    if (
      pathname.startsWith('/api/staff') &&
      method.toUpperCase() === 'GET' &&
      response &&
      response.status === 200
    ) {
      const role = decision.auth && (decision.auth.sessionRole || decision.auth.role);
      try {
        const body = await response.clone().json();
        return json(redactStaffForRole(body, role));
      } catch {
        return response; // not JSON — pass through untouched
      }
    }

    return response;
  },

  // Cron: publish any content scheduled for now, put back tables that nobody
  // cleared, and run the SLA rules over live orders. All three only happen if
  // something asks — this is the something.
  async scheduled(event, env, ctx) {
    // Awaited here: cron is the one caller that wants the quota view current
    // BEFORE deciding what this minute may afford.
    try {
      await quotaTick(env, ctx);
    } catch {
      // Same contract as everywhere else: bookkeeping never breaks the job.
    }
    // KV-only — content publishing is priced in a different currency and
    // keeps running in every mode.
    await checkScheduledPublish(env);
    // The three D1-backed sweeps throttle themselves as the budget drains:
    // every minute in normal/conserve, every other minute in emergency, not
    // at all in critical. A paused sweep delays SLA banners and stale-table
    // release by minutes; it does not lose them — the next unpaused minute
    // catches up.
    if (!cronShouldSweep()) return;
    try {
      const { table } = await loadStaleHours(env);
      await releaseOverstayedTables(env, table);
    } catch (e) {
      // A sweep that fails must not stop the scheduled publish, and there is
      // nobody to tell — the next minute tries again.
      console.error('[SWEEP] tables', e);
    }
    try {
      const r = await runAlertSweep(env);
      if (!r.skipped && (r.raised || r.changed || r.resolved)) {
        console.log('[SWEEP] alerts', JSON.stringify(r));
      }
    } catch (e) {
      // Same contract as the tables sweep: fail alone, try again next minute.
      console.error('[SWEEP] alerts', e);
    }
    try {
      const r = await autoCompleteStaleOrders(env);
      // Quiet when nothing closed — a log line every minute would be noise.
      if (r.closed) console.log('[SWEEP] auto-close', JSON.stringify(r));
    } catch (e) {
      // Same contract: fail alone, try again next minute.
      console.error('[SWEEP] auto-close', e);
    }
  },
};
