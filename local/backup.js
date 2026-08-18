#!/usr/bin/env node
/**
 * A consistent snapshot of the local database.
 *
 *   node local/backup.js [destination]
 *   FUFUT_DATA_DIR=/data FUFUT_BACKUP_DIR=/backups node local/backup.js
 *
 * Copying `fufut.sqlite` with `cp` is the obvious thing and it is wrong: in WAL
 * mode the file on its own is not the database, and a copy taken mid-write is a
 * backup that restores to a corrupt or truncated state. `VACUUM INTO` asks
 * SQLite for a consistent snapshot of the whole thing while the server keeps
 * trading, which is the only kind of backup worth having on a box that never
 * stops.
 *
 * From the design doc: "Local box lost or stolen — everything since the last
 * successful sync is gone. This is why the nightly copy is not optional." Until
 * the sync engine exists (stage 4), this file IS the disaster plan.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DATA_DIR = process.env.FUFUT_DATA_DIR || path.join(import.meta.dirname, '..', 'data');
const BACKUP_DIR = process.argv[2] || process.env.FUFUT_BACKUP_DIR || path.join(DATA_DIR, 'backups');
/** Enough history to notice a problem that started a week ago. */
const KEEP_DAYS = Number(process.env.FUFUT_BACKUP_KEEP_DAYS || 14);

const source = path.join(DATA_DIR, 'fufut.sqlite');

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function prune() {
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of fs.readdirSync(BACKUP_DIR)) {
    if (!/^fufut-.*\.sqlite$/.test(name)) continue;
    const file = path.join(BACKUP_DIR, name);
    if (fs.statSync(file).mtimeMs < cutoff) {
      fs.rmSync(file);
      removed += 1;
    }
  }
  return removed;
}

function main() {
  if (!fs.existsSync(source)) {
    console.error(`[backup] no database at ${source}`);
    process.exit(1);
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const target = path.join(BACKUP_DIR, `fufut-${stamp()}.sqlite`);
  if (fs.existsSync(target)) {
    console.error(`[backup] ${target} already exists; refusing to overwrite`);
    process.exit(1);
  }

  const db = new DatabaseSync(source, { readOnly: true });
  try {
    // The path is interpolated because VACUUM INTO takes no bound parameter.
    // It comes from the environment or argv, never from a request.
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }

  // A backup nobody checked is a backup nobody has. Open the snapshot and
  // confirm it is a readable database with the rows in it, so a silent failure
  // surfaces tonight rather than on the morning it is needed.
  const check = new DatabaseSync(target, { readOnly: true });
  let orders;
  try {
    const integrity = check.prepare('PRAGMA integrity_check').get();
    const result = integrity.integrity_check || Object.values(integrity)[0];
    if (result !== 'ok') throw new Error(`integrity check said: ${result}`);
    orders = check.prepare('SELECT count(*) AS n FROM orders').get().n;
  } finally {
    check.close();
  }

  const size = (fs.statSync(target).size / 1024 / 1024).toFixed(1);
  const pruned = prune();
  console.log(`[backup] ${target} — ${size} MB, ${orders} orders, verified${pruned ? `, pruned ${pruned}` : ''}`);
}

main();
