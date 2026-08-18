/**
 * A D1 binding backed by SQLite on the local box.
 *
 * D1 is SQLite underneath, so the SQL the handlers already write needs no
 * translation. What differs is the JavaScript surface around it, and that is
 * all this file is: prepare/bind/all/run/first/raw/batch, shaped exactly as
 * the Workers runtime shapes them, so `src/handlers/*` runs unmodified.
 *
 * The governing rule here is that the adapter must never be MORE permissive
 * than D1. A local server that accepts what production rejects is worse than
 * no local server, because the bug ships. Every deliberate divergence below is
 * in that direction: match D1, or fail the same way D1 fails.
 *
 * Uses node:sqlite, built into Node 22.5+, so there is no native module to
 * compile and the Docker image needs no build toolchain.
 */

import { DatabaseSync } from 'node:sqlite';

/**
 * D1 accepts booleans and stores them as 1/0; node:sqlite refuses to bind them
 * outright. Without this coercion a handler binding a boolean would work in
 * production and throw on the local box — the divergence runs the dangerous
 * way, so we close it.
 *
 * `undefined` is rejected by both, and stays rejected. It nearly always means a
 * property name typo, and silently binding NULL would turn a loud bug into a
 * quiet one.
 */
function toSqlite(value, index) {
  if (value === null) return null;
  switch (typeof value) {
    case 'boolean': return value ? 1 : 0;
    case 'string':
    case 'number':
    case 'bigint': return value;
    case 'object':
      if (value instanceof Uint8Array) return value;
      break;
  }
  if (value === undefined) {
    throw new TypeError(
      `D1_TYPE_ERROR: parameter ${index + 1} is undefined. ` +
      'D1 rejects undefined bindings; pass null if the value is genuinely absent.'
    );
  }
  throw new TypeError(
    `D1_TYPE_ERROR: parameter ${index + 1} is a ${value.constructor?.name || typeof value}, ` +
    'which D1 cannot bind. Serialise it first.'
  );
}

/**
 * node:sqlite returns rows with a null prototype. They stringify and spread
 * correctly, so most code never notices — until something calls
 * `row.hasOwnProperty(...)` and dies on a row that came back fine from D1.
 * Cheap to normalise, and it removes the whole class of difference.
 */
function plain(row) {
  return Object.assign({}, row);
}

/** Rowids arrive as BigInt past 2^53; D1's last_row_id is always a number. */
function toNumber(value) {
  return typeof value === 'bigint' ? Number(value) : value;
}

class LocalPreparedStatement {
  constructor(db, sql, params) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  /** D1 statements are immutable: bind returns a new statement. */
  bind(...params) {
    return new LocalPreparedStatement(this.db, this.sql, params.map(toSqlite));
  }

  _stmt() {
    // node:sqlite caches compiled statements internally, so re-preparing the
    // same SQL is cheap and keeps this object safe to reuse and to re-run.
    return this.db.prepare(this.sql);
  }

  async all() {
    const started = performance.now();
    const rows = this._stmt().all(...this.params);
    return {
      success: true,
      results: rows.map(plain),
      meta: { duration: performance.now() - started, rows_read: rows.length, rows_written: 0, changes: 0, last_row_id: 0 },
    };
  }

  async run() {
    const started = performance.now();
    const info = this._stmt().run(...this.params);
    return {
      success: true,
      results: [],
      meta: {
        duration: performance.now() - started,
        changes: toNumber(info.changes),
        last_row_id: toNumber(info.lastInsertRowid),
        rows_read: 0,
        rows_written: toNumber(info.changes),
      },
    };
  }

  /** D1: the first row, or a single column of it, or null when there are none. */
  async first(column) {
    const row = this._stmt().get(...this.params);
    if (row === undefined) return null;
    return column === undefined ? plain(row) : row[column] ?? null;
  }

  /** D1: rows as arrays of values rather than objects. */
  async raw({ columns = false } = {}) {
    const rows = this._stmt().all(...this.params);
    const names = rows.length ? Object.keys(rows[0]) : [];
    const out = rows.map((r) => names.map((n) => r[n]));
    return columns ? [names, ...out] : out;
  }
}

class LocalD1Database {
  constructor(db) {
    this.db = db;
  }

  prepare(sql) {
    return new LocalPreparedStatement(this.db, sql, []);
  }

  /**
   * D1 runs a batch as a single transaction, so a half-applied batch is not a
   * state the handlers are written to survive. `orders.js` relies on this: an
   * order and its items go in together or not at all.
   */
  async batch(statements) {
    this.db.exec('BEGIN');
    try {
      const out = [];
      for (const statement of statements) out.push(await statement.run());
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* the transaction was already gone */ }
      throw err;
    }
  }

  async exec(sql) {
    this.db.exec(sql);
    return { count: 0, duration: 0 };
  }
}

/**
 * Open the local database and return something usable as `env.DB`.
 *
 * The pragmas are not decoration. WAL lets the kitchen display keep reading
 * while a waiter writes, which on a single box during service is the whole
 * ballgame; `busy_timeout` makes a concurrent writer wait its turn instead of
 * throwing SQLITE_BUSY at a member of staff; `foreign_keys` is off by default
 * in SQLite and D1 enforces its constraints, so leaving it off would be another
 * way for the local box to accept what production refuses.
 */
export function openLocalD1(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
  return { db, DB: new LocalD1Database(db) };
}

export { LocalD1Database };
