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

import { handleContent, checkScheduledPublish } from './handlers/content.js';
import { handleOrders, loadStaleHours } from './handlers/orders.js';
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
import { handleTables, releaseOverstayedTables } from './handlers/tables.js';
import { handleStaff } from './handlers/staff.js';
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

  if (pathname === '/api/auth/login' && upper === 'POST') return handleStaffLogin(request, env);
  if (pathname === '/api/auth/me' && upper === 'GET') return handleSessionCheck(request, env);
  if (pathname === '/api/auth/logout' && upper === 'POST') return handleLogout(request, env);
  if (pathname === '/api/auth/reset-password' && upper === 'POST') return handleResetPassword(request, env);
  if (pathname === '/api/auth/change-password' && upper === 'POST') return handleChangePassword(request, env);
  if (pathname === '/api/upload' && upper === 'POST') return handleUpload(request, env);
  if (pathname.startsWith('/api/images/') && upper === 'GET') return serveImage(env, pathname);

  const migration = await handleMigration(request, env);
  if (migration !== null) return migration;

  const content = await handleContent(pathname, method, url, request, env);
  if (content !== null) return content;

  if (pathname === '/api/events/tables' || pathname === '/api/events/kitchen') {
    return handleSSE(request, env, pathname.endsWith('tables') ? 'tables' : 'kitchen');
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
    const r = await handleOrders(pathname, method, url, request, env, auth);
    if (r !== null) return r;
  }
  // Payments and tips are separate resources from orders on purpose: a waiter
  // may take an order and may not verify a bank transfer, and a tip is not
  // revenue. Gated independently in the role matrix for both reasons.
  if (pathname.startsWith('/api/payments') || pathname.startsWith('/api/tips')) {
    const r = await handlePayments(pathname, method, url, request, env, auth);
    if (r !== null) return r;
  }
  if (pathname.startsWith('/api/audit')) {
    const r = await handleAudit(pathname, method, url, env);
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

    // ── Authorization gate ──────────────────────────────────────────────
    const decision = await authorize(request, env, pathname, method.toUpperCase());
    if (!decision.ok) return decision.response;

    const response = await route(pathname, method, url, request, env, ctx, decision.auth);

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

  // Cron: publish any content scheduled for now, and put back tables that
  // nobody cleared. Both are things that only happen if something asks.
  async scheduled(event, env, ctx) {
    await checkScheduledPublish(env);
    try {
      const { table } = await loadStaleHours(env);
      await releaseOverstayedTables(env, table);
    } catch (e) {
      // A sweep that fails must not stop the scheduled publish, and there is
      // nobody to tell — the next minute tries again.
      console.error('[SWEEP] tables', e);
    }
  },
};
