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
import { handleOrders } from './handlers/orders.js';
import { handleReservations } from './handlers/reservations.js';
import { handleReviews } from './handlers/reviews.js';
import { handleMenu } from './handlers/menu.js';
import { handleGallery } from './handlers/gallery.js';
import { handleUpload } from './handlers/upload.js';
import { handleMigration } from './handlers/migration.js';
import { handleResources } from './handlers/resources.js';
import { handleTables } from './handlers/tables.js';
import { handleSSE } from './handlers/sse.js';
import {
  handleStaffLogin,
  handleSessionCheck,
  handleLogout,
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
  if (pathname === '/api/upload' && upper === 'POST') return handleUpload(request, env);
  if (pathname.startsWith('/api/images/') && upper === 'GET') return serveImage(env, pathname);

  const migration = await handleMigration(request, env);
  if (migration !== null) return migration;

  const content = await handleContent(pathname, method, url, request, env);
  if (content !== null) return content;

  if (pathname === '/api/events/tables' || pathname === '/api/events/kitchen') {
    return handleSSE(request, env, pathname.endsWith('tables') ? 'tables' : 'kitchen');
  }

  if (pathname.startsWith('/api/orders')) {
    const r = await handleOrders(pathname, method, url, request, env);
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

  // Cron: publish any content scheduled for now.
  async scheduled(event, env, ctx) {
    await checkScheduledPublish(env);
  },
};
