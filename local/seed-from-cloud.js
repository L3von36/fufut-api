#!/usr/bin/env node
/**
 * Fill a local database from the live one, so the box has a real venue in it.
 *
 *   node local/seed-from-cloud.js            # refuses if data is already there
 *   node local/seed-from-cloud.js --force    # replaces the local database
 *   node local/seed-from-cloud.js --schema-only
 *
 * A rehearsal needs the real staff, the real menu and the real tables — a box
 * seeded with invented data proves nothing about the venue that will use it.
 *
 * TWO THINGS TO BE CLEAR ABOUT BEFORE RUNNING THIS.
 *
 * It copies **real trading data onto a physical machine**: password hashes,
 * staff records, customer names and phone numbers. That box now needs the same
 * care as the cloud database — disk encryption, a password on the machine, and
 * a plan for what happens if it is stolen.
 *
 * And there is **no sync** (stage 4). The moment this finishes, the copy starts
 * drifting from production, and nothing reconciles them. Every order taken on
 * the box during the rehearsal exists only on the box. That is fine for a
 * rehearsal and ruinous if mistaken for a migration.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const DATA_DIR = process.env.FUFUT_DATA_DIR || path.join(import.meta.dirname, '..', 'data');
const DATABASE = process.env.FUFUT_D1_NAME || 'fufut-db';
const force = process.argv.includes('--force');
const schemaOnly = process.argv.includes('--schema-only');
const target = path.join(DATA_DIR, 'fufut.sqlite');

/**
 * `--from-file <dump.sql>` — apply an export taken somewhere else.
 *
 * This is the path the box in the cafe actually uses, and it exists because the
 * obvious one does not work there. Exporting needs wrangler, and wrangler is
 * deliberately not in the image: there is no `npm ci`, which is what makes the
 * image small and free of a runtime supply chain. Even if it were, exporting
 * needs Cloudflare credentials, and `wrangler login` wants a browser — on a
 * headless mini PC behind a cafe counter there isn't one.
 *
 * So the export happens before anybody travels, on a machine already signed in,
 * and the .sql file goes on the USB stick with everything else. Applying it on
 * the box is then just reading a file: no download over the connection this
 * whole project exists to work around, and no credentials on the box at all.
 */
const fileFlag = process.argv.indexOf('--from-file');
const fromFile = fileFlag !== -1 ? process.argv[fileFlag + 1] : null;

function hasData(file) {
  if (!fs.existsSync(file)) return false;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get().n;
    if (!tables) return false;
    return db.prepare('SELECT count(*) AS n FROM orders').get().n > 0;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

function main() {
  if (hasData(target) && !force) {
    console.error(`[seed] ${target} already holds orders.`);
    console.error('[seed] Refusing to overwrite. Back it up, then pass --force.');
    process.exit(1);
  }

  let dump;
  let temporary = null;

  if (fromFile) {
    dump = path.resolve(fromFile);
    if (!fs.existsSync(dump)) {
      console.error(`[seed] no such file: ${dump}`);
      process.exit(1);
    }
    const mb = (fs.statSync(dump).size / 1024 / 1024).toFixed(1);
    console.log(`[seed] applying ${dump} (${mb} MB) — no network needed`);
  } else {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fufut-seed-'));
    dump = path.join(temporary, 'export.sql');
    const args = ['wrangler', 'd1', 'export', DATABASE, '--remote', '--output', dump, '-y'];
    if (schemaOnly) args.push('--no-data');

    console.log(`[seed] exporting ${DATABASE} from Cloudflare — this is the slow part`);
    try {
      execFileSync('npx', args, { stdio: 'inherit', shell: process.platform === 'win32' });
    } catch (e) {
      console.error('\n[seed] the export failed.');
      console.error('[seed] Running inside the container? wrangler is not in the image, and');
      console.error('[seed] exporting needs Cloudflare credentials this box does not have.');
      console.error('[seed] Take the dump on a machine that is already signed in:');
      console.error(`[seed]   npx wrangler d1 export ${DATABASE} --remote --output fufut-dump.sql -y`);
      console.error('[seed] then bring the file here and run:');
      console.error('[seed]   node local/seed-from-cloud.js --from-file fufut-dump.sql');
      process.exit(1);
    }
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Replace rather than merge. Merging a full export into a database that has
  // its own rows is how you end up with two versions of a table's occupancy and
  // no way to tell which is true.
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(target + suffix, { force: true });

  const db = new DatabaseSync(target);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    // The export carries its own CREATE TABLE statements, so foreign keys stay
    // off until it has finished loading: the dump is not ordered by dependency.
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(fs.readFileSync(dump, 'utf8'));
    db.exec('PRAGMA foreign_keys = ON');

    const counts = ['staff', 'menu', 'tables', 'orders']
      .map((t) => {
        try {
          return `${t} ${db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n}`;
        } catch {
          return `${t} —`;
        }
      })
      .join(', ');
    console.log(`[seed] ${target}: ${counts}`);
  } finally {
    db.close();
    // Only ever the directory this script created. `path.dirname(dump)` would
    // recursively delete whatever folder a --from-file dump was read from —
    // which, given the file arrives on a USB stick, means the USB stick.
    if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
  }

  console.log('[seed] This copy does not sync. Anything entered on the box stays on the box.');
}

main();
