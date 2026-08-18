#!/usr/bin/env node
/**
 * Copy the deployed POS and backoffice onto the box.
 *
 *   node local/mirror-bundles.mjs [web-dir]
 *
 * Building the apps locally is the obvious way to get bundles for the box, and
 * right now it produces broken ones: vite 8.1.5 emits chunk files with an extra
 * hash segment (`AppLayout-dRSWbmr3-Gibc_EBk.js`) while the bundle's own import
 * map still asks for `AppLayout-dRSWbmr3.js`. Every lazily-loaded route 404s.
 *
 * What Cloudflare serves was built before that version landed and works. It is
 * also the artifact the venue has actually been using, which makes it the
 * better thing to put on the box regardless: the box should run what the cafe
 * runs, not a fresh build nobody has exercised.
 *
 * Needs the internet, so it belongs with the other before-you-travel steps.
 */

import fs from 'node:fs';
import path from 'node:path';

const WEB = path.resolve(process.argv[2] || 'web');

/**
 * The POS only, and deliberately.
 *
 * The backoffice is built locally with `--base /backoffice/`, which produces a
 * bundle whose asset URLs already point where it is mounted. Mirroring it
 * instead means taking a bundle built for a subdomain root and trying to
 * rewrite `/assets/` to `/backoffice/assets/` inside minified JavaScript — I
 * tried that, it silently missed occurrences, and the backoffice loaded its
 * shell and then asked the POS's directory for its own chunks.
 *
 * The POS cannot be treated the same way: its service worker registration and
 * cache list are root-absolute, so it has to sit at the origin root, and the
 * one currently deployed is the only bundle that works (see the vite 8.1.5 note
 * in INSTALL.md).
 */
const APPS = [
  { name: 'pos', origin: 'https://pos.fufutcoffee.com', dir: WEB },
];

/** Root-level files a build ships that nothing links to from the HTML. */
const EXTRAS = [
  'sw.js', 'manifest.json', 'favicon.ico', 'favicon.svg', 'favicon-16x16.png',
  'favicon-32x32.png', 'favicon-64.png', 'favicon-128.png', 'apple-touch-icon.png',
  'robots.txt', '_headers',
];

async function grab(origin, urlPath) {
  const res = await fetch(origin + urlPath);
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

function write(dir, urlPath, body) {
  const file = path.join(dir, urlPath.replace(/^\//, ''));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

/**
 * Asset names referenced from a file. Crawled rather than guessed because the
 * lazy route chunks are named only inside the JavaScript, never in the HTML —
 * which is exactly the set that a naive "copy index.html and assets/" misses.
 */
function referenced(text, base) {
  const out = new Set();

  // Anything written with an explicit assets/ path — how index.html links the
  // entry chunk and stylesheet.
  for (const m of text.matchAll(/["'`(]([^"'`()\s]*assets\/[A-Za-z0-9._-]+\.(?:js|css|woff2?|png|jpe?g|svg|webp))/g)) {
    // Normalise from the last `assets/` onwards. Vite's preload map lists CSS
    // as a bare `assets/Name-hash.css`, and naively prefixing the base turns
    // that into `/assets/assets/…` — a 404 that leaves every route's
    // stylesheet behind while the JavaScript all arrives.
    const ref = '/' + m[1].slice(m[1].lastIndexOf('assets/'));
    out.add(ref);
  }

  // And the lazy route chunks, which a chunk already inside assets/ names
  // relatively — `import("./AppLayout-BRrscFff.js")` — with no assets/ prefix
  // to match on. Missing these is missing every screen after the login page,
  // and the crawl looks like it succeeded because index.html alone resolves.
  for (const m of text.matchAll(/["'`(]\.{0,2}\/?([A-Za-z0-9._]+-[A-Za-z0-9_-]{6,}\.(?:js|css))["'`)]/g)) {
    out.add(base + m[1]);
  }

  return out;
}

async function mirror({ name, origin, dir }) {
  const html = await grab(origin, '/');
  if (!html) {
    console.error(`[mirror] ${name}: ${origin} did not answer`);
    return false;
  }
  fs.mkdirSync(dir, { recursive: true });
  write(dir, 'index.html', html);

  const base = name === 'pos' ? '/assets/' : '/assets/';
  const queue = [...referenced(html.toString('utf8'), base)];
  const seen = new Set();
  let bytes = html.length;

  while (queue.length) {
    const ref = queue.shift();
    if (seen.has(ref)) continue;
    seen.add(ref);

    const body = await grab(origin, ref);
    if (!body) {
      console.error(`[mirror] ${name}: MISSING ${ref}`);
      continue;
    }
    write(dir, ref, body);
    bytes += body.length;

    if (ref.endsWith('.js') || ref.endsWith('.css')) {
      for (const next of referenced(body.toString('utf8'), base)) {
        if (!seen.has(next)) queue.push(next);
      }
    }
  }

  for (const extra of EXTRAS) {
    const body = await grab(origin, '/' + extra);
    if (body) { write(dir, extra, body); bytes += body.length; }
  }

  console.log(`[mirror] ${name}: ${seen.size} assets, ${(bytes / 1024 / 1024).toFixed(1)} MB -> ${dir}`);
  return true;
}

let ok = true;
for (const app of APPS) ok = (await mirror(app)) && ok;

if (!ok) process.exit(1);

console.log('[mirror] the POS is done. Build the backoffice separately:');
console.log('[mirror]   cd ../fufut-management/backoffice && npx vite build --base /backoffice/');
console.log('[mirror]   cp -r dist/. ../../fufut-api/web/backoffice/');

console.log('[mirror] this is the bundle the cafe is already running.');
