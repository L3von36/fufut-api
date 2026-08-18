/**
 * Assemble the `env` object the Worker expects, backed by the local box.
 *
 * The Worker's own code never learns it is running here. Everything it reaches
 * for — `env.DB`, the six KV namespaces, `env.IMAGES_R2` — is present with the
 * same shape, which is what lets `src/handlers/*` run without a single edit.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openLocalD1 } from './d1.js';
import { createKVNamespaces } from './kv.js';
import { createR2Bucket } from './r2.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Mirrors the bindings in wrangler.toml. Drifting from that list is a bug. */
export const KV_NAMESPACES = [
  'CONTENT_KV',
  'MENU_KV',
  'ORDERS_KV',
  'RESERVATIONS_KV',
  'REVIEWS_KV',
  'GALLERY_KV',
];

/**
 * The schema is dumped from production rather than rebuilt from the migration
 * history. Replaying 13 migrations to arrive at a state we can read directly
 * off the live database is a chance to arrive somewhere subtly different, and
 * the whole value of the local box is that it behaves identically.
 */
export function applySchema(db, schemaPath = path.join(HERE, 'schema.sql')) {
  const sql = fs.readFileSync(schemaPath, 'utf8');
  db.exec(sql);
}

function isEmpty(db) {
  const row = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get();
  return row.n === 0;
}

/**
 * Open (creating if needed) the local database and build an env around it.
 *
 * `dir` holds everything with state in it: the SQLite file and the image
 * bucket. It is the only thing that needs backing up, and in the Docker build
 * it is the only bind mount.
 */
export function createLocalEnv({ dir = process.env.FUFUT_DATA_DIR || path.join(HERE, '..', 'data'), quiet = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'fufut.sqlite');
  const fresh = !fs.existsSync(dbPath);

  const { db, DB } = openLocalD1(dbPath);
  if (fresh || isEmpty(db)) {
    applySchema(db);
    if (!quiet) console.log(`[fufut] created a new database at ${dbPath}`);
  }

  const env = {
    DB,
    IMAGES_R2: createR2Bucket(path.join(dir, 'images')),
    ...createKVNamespaces(db, KV_NAMESPACES),

    /**
     * Who this side is, in sync terms. The box always has an identity — it is
     * one of the two writers by definition — so capture is on here from the
     * start, while the deployed cloud Worker stays untouched until SITE_ID is
     * set on it deliberately.
     *
     * One venue for now, so the ids are fixed rather than provisioned.
     * `sync_outbox` and the cursors are keyed on them, which is what makes
     * adding a second venue later a configuration change rather than a
     * migration.
     */
    SITE_ID: 'local',
    /** Where to sync to. Unset means the box journals but never talks. */
    CLOUD_URL: undefined,
    /** Shared secret for the machine-to-machine sync routes. */
    SYNC_TOKEN: undefined,

    // Anything configured as a Worker var or secret passes through, so the same
    // handlers can read it here — and so the three above can be overridden from
    // the environment or docker-compose.
    ...process.env,
  };

  return { env, db, dir, dbPath };
}
