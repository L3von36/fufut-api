#!/usr/bin/env node
/**
 * Copy the menu photographs onto the box.
 *
 *   node local/mirror-images.mjs
 *
 * Seeding brings the database, which holds the *references* to images —
 * `/api/images/menu/1785388735992-ef215242.jpg` — while the pictures themselves
 * live in Cloudflare R2. On the box `env.IMAGES_R2` is a directory, and a fresh
 * one is empty, so every dish on the till renders with a broken image. The data
 * looked complete and the screen did not.
 *
 * The images are fetched through the public `/api/images/` route rather than
 * out of R2 with wrangler, for the same reason the database dump is taken
 * before travelling: no credentials on the box, and nothing to install.
 *
 * Needs the internet. It belongs immediately after seeding.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DATA_DIR = process.env.FUFUT_DATA_DIR || path.join(import.meta.dirname, '..', 'data');
const ORIGIN = process.env.FUFUT_CLOUD_ORIGIN || 'https://fufut-api.fufutcoffee.workers.dev';
const dbPath = path.join(DATA_DIR, 'fufut.sqlite');
const bucket = path.join(DATA_DIR, 'images');

const TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.avif': 'image/avif',
};

/**
 * The R2 key behind a stored value.
 *
 * Most rows hold `/api/images/<key>`, but some hold the full production URL —
 * those bypass the box entirely and would fail during exactly the outage the
 * box exists for. Both forms reduce to the same key here, so the picture at
 * least lands on disk either way; the stored value is a separate problem, and
 * this prints a count rather than editing the venue's data behind its back.
 */
function keyOf(value) {
  const v = String(value || '');
  const at = v.indexOf('/api/images/');
  if (at === -1) return null;
  try {
    return decodeURIComponent(v.slice(at + '/api/images/'.length));
  } catch {
    return v.slice(at + '/api/images/'.length);
  }
}

if (!fs.existsSync(dbPath)) {
  console.error(`[images] no database at ${dbPath} — seed first`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const values = new Set();
let absolute = 0;

for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
  let cols = [];
  try { cols = db.prepare(`PRAGMA table_info(${t.name})`).all().map((c) => c.name); } catch { continue; }
  for (const c of cols) {
    if (!/image|photo|logo|avatar|picture/i.test(c)) continue;
    try {
      for (const r of db.prepare(`SELECT ${c} v FROM ${t.name} WHERE ${c} IS NOT NULL AND ${c} <> ''`).all()) {
        if (/^https?:\/\//.test(String(r.v))) absolute += 1;
        values.add(r.v);
      }
    } catch { /* column is not text, or the table is odd — skip it */ }
  }
}
db.close();

const keys = [...new Set([...values].map(keyOf).filter(Boolean))];
console.log(`[images] ${keys.length} referenced by the venue`);

fs.mkdirSync(bucket, { recursive: true });
let fetched = 0;
let already = 0;
let missing = 0;
let bytes = 0;

for (const key of keys) {
  const file = path.join(bucket, key);
  if (fs.existsSync(file)) { already += 1; continue; }

  const res = await fetch(`${ORIGIN}/api/images/${encodeURIComponent(key)}`);
  if (!res.ok) {
    console.error(`[images] MISSING ${key} (${res.status})`);
    missing += 1;
    continue;
  }
  const body = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);

  // The R2 shim reads this sidecar to set Content-Type. Without it the image
  // still serves, but as application/octet-stream, and the browser will not
  // render it — a subtler version of the same broken picture.
  const type = res.headers.get('content-type') || TYPES[path.extname(key).toLowerCase()] || 'application/octet-stream';
  fs.writeFileSync(`${file}.meta.json`, JSON.stringify({ contentType: type }));

  fetched += 1;
  bytes += body.length;
}

console.log(`[images] fetched ${fetched}, already had ${already}, missing ${missing}, ${(bytes / 1024 / 1024).toFixed(1)} MB`);
if (absolute) {
  console.log(`[images] ${absolute} row(s) store a full cloud URL rather than /api/images/…`);
  console.log('[images] the pictures are on the box now, but those rows still point at Cloudflare');
  console.log('[images] and will not render during an outage. Worth correcting in the menu editor.');
}
