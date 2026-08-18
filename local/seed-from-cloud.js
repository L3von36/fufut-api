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

  const dump = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fufut-seed-')), 'export.sql');
  const args = ['wrangler', 'd1', 'export', DATABASE, '--remote', '--output', dump, '-y'];
  if (schemaOnly) args.push('--no-data');

  console.log(`[seed] exporting ${DATABASE} from Cloudflare — this is the slow part`);
  execFileSync('npx', args, { stdio: 'inherit', shell: process.platform === 'win32' });

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
    fs.rmSync(path.dirname(dump), { recursive: true, force: true });
  }

  console.log('[seed] This copy does not sync. Anything entered on the box stays on the box.');
}

main();
