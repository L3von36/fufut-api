/**
 * Serving the built POS and backoffice from the box.
 *
 * This is what makes an outage survivable rather than merely logged. A tablet
 * that can reach the API but has to fetch the app itself from Cloudflare Pages
 * is still a tablet that shows nothing when the line is down.
 *
 * It works without rebuilding anything because of one line in the POS:
 *
 *     export const API = import.meta.env.VITE_API_URL || ''
 *
 * The apps default to same-origin. Served from the same box that answers
 * `/api/*`, the production bundle points at the local API by itself, and the
 * session cookie stays first-party — no CORS, no third-party cookie blocking,
 * no separate build for the cafe.
 *
 * Layout under FUFUT_WEB_DIR: an app at the root, and/or apps in
 * subdirectories, e.g.
 *
 *     web/index.html            <- POS, built with --base=/
 *     web/backoffice/index.html <- backoffice, built with --base=/backoffice/
 *
 * The base a bundle was built with has to match where it is mounted, because
 * that is what its asset URLs are written against.
 */

import fs from 'node:fs';
import path from 'node:path';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Vite fingerprints everything under /assets/, so those may be cached hard.
 * Everything else — index.html above all, and the service worker — must not be,
 * or a tablet keeps running the version it had when the box was last updated.
 */
function cacheControl(file) {
  if (/[.-][0-9a-zA-Z_]{8,}\.[a-z0-9]+$/.test(path.basename(file)) && file.includes('assets')) {
    return 'public, max-age=31536000, immutable';
  }
  return 'no-cache';
}

function safeResolve(root, urlPath) {
  // decodeURIComponent can throw on a malformed escape; a bad URL is a 404, not
  // a crash.
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;

  const target = path.resolve(root, '.' + path.posix.normalize(decoded));
  const bounded = path.resolve(root) + path.sep;
  if (target !== path.resolve(root) && !target.startsWith(bounded)) return null;
  return target;
}

function statFile(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

/**
 * The SPA fallback, walking up rather than jumping to the root.
 *
 * `/backoffice/payroll` is a client-side route of the backoffice app, so it has
 * to land on `/backoffice/index.html` — serving the root POS shell instead
 * would leave a manager staring at the wrong application. Walking up finds the
 * nearest mounted app, whatever the layout.
 */
function findShell(root, target) {
  let dir = fs.existsSync(target) && fs.statSync(target).isDirectory() ? target : path.dirname(target);
  const stop = path.resolve(root);
  for (;;) {
    const shell = path.join(dir, 'index.html');
    if (statFile(shell)) return shell;
    if (dir === stop) return null;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * Returns a handler that answers with the built apps, or returns false so the
 * caller can pass the request on to the Worker.
 *
 * Returns null entirely when no web directory is configured — the box is then
 * an API-only server, which is what stage 2 was.
 */
export function createStaticHandler(webDir) {
  if (!webDir || !fs.existsSync(webDir)) return null;
  const root = path.resolve(webDir);

  return function serveStatic(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;

    const urlPath = req.url.split('?')[0];
    const target = safeResolve(root, urlPath);
    if (!target) return false;

    let file = statFile(target) ? target : null;

    // A directory request resolves to its index, so /backoffice/ works.
    if (!file && statFile(path.join(target, 'index.html'))) {
      file = path.join(target, 'index.html');
    }

    if (!file) {
      // Never hand an HTML shell back for a missing asset: the browser would
      // try to parse index.html as JavaScript and the failure would look like a
      // syntax error in the app rather than a missing file.
      if (path.extname(urlPath)) return false;
      file = findShell(root, target);
      if (!file) return false;
    }

    const stat = statFile(file);
    if (!stat) return false;

    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': cacheControl(file),
    });
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    fs.createReadStream(file).pipe(res);
    return true;
  };
}
