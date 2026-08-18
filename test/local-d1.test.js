/**
 * The D1 adapter, tested where it can diverge from D1.
 *
 * The value of the local server rests entirely on the claim that the handlers
 * behave the same on it as on Cloudflare. Everything here is a place where the
 * underlying SQLite driver does NOT behave like D1 and the adapter has to close
 * the gap — a plain "does SELECT work" test would prove nothing about that.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openLocalD1 } from '../local/d1.js';

let dir;
let db;
let DB;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fufut-d1-'));
  ({ db, DB } = openLocalD1(path.join(dir, 'test.sqlite')));
  db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, name TEXT, flag INTEGER, qty INTEGER)');
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('result shapes match D1', () => {
  it('all() returns { results } even when nothing matches', async () => {
    const out = await DB.prepare('SELECT * FROM t WHERE id = ?').bind('nobody').all();
    expect(out.results).toEqual([]);
    expect(out.success).toBe(true);
  });

  it('run() reports changes, which is what every guarded update reads', async () => {
    await DB.prepare('INSERT INTO t (id, name) VALUES (?, ?)').bind('t1', 'Table 1').run();

    // The atomic-claim pattern: the UPDATE decides, and meta.changes is the
    // answer. If this ever came back undefined, every seat claim would silently
    // read as a failure.
    const won = await DB.prepare("UPDATE t SET name = ? WHERE id = ? AND name <> 'taken'").bind('taken', 't1').run();
    const lost = await DB.prepare("UPDATE t SET name = ? WHERE id = ? AND name <> 'taken'").bind('taken', 't1').run();

    expect(won.meta.changes).toBe(1);
    expect(lost.meta.changes).toBe(0);
  });

  it('rows are ordinary objects, not the null-prototype ones the driver returns', async () => {
    await DB.prepare('INSERT INTO t (id, name) VALUES (?, ?)').bind('t1', 'Table 1').run();
    const { results } = await DB.prepare('SELECT * FROM t').all();

    // node:sqlite hands back Object.create(null), which stringifies fine and
    // then dies the first time anything calls a method on it.
    expect(Object.getPrototypeOf(results[0])).toBe(Object.prototype);
    expect(results[0].hasOwnProperty('name')).toBe(true);
  });

  it('first() returns null for no row, and a single column when asked', async () => {
    expect(await DB.prepare('SELECT * FROM t WHERE id = ?').bind('none').first()).toBeNull();
    await DB.prepare('INSERT INTO t (id, name) VALUES (?, ?)').bind('t1', 'Table 1').run();
    expect(await DB.prepare('SELECT * FROM t').first('name')).toBe('Table 1');
  });
});

describe('binding matches what D1 accepts', () => {
  it('accepts booleans, which the driver alone refuses', async () => {
    // D1 stores a bound boolean as 1/0. node:sqlite throws on it outright, so
    // without coercion a handler binding a boolean would work in production and
    // fail on the box in the cafe.
    await DB.prepare('INSERT INTO t (id, flag) VALUES (?, ?)').bind('t1', true).run();
    await DB.prepare('INSERT INTO t (id, flag) VALUES (?, ?)').bind('t2', false).run();

    const { results } = await DB.prepare('SELECT id, flag FROM t ORDER BY id').all();
    expect(results.map((r) => r.flag)).toEqual([1, 0]);
  });

  it('still rejects undefined, because D1 rejects it', async () => {
    // The adapter is allowed to be as strict as D1 and never looser. undefined
    // is almost always a misspelled property, and binding NULL instead would
    // turn a crash into a wrong row.
    // D1 raises this from bind() itself, not from the eventual run(), so the
    // failure lands on the line that got it wrong.
    expect(
      () => DB.prepare('INSERT INTO t (id, name) VALUES (?, ?)').bind('t1', undefined)
    ).toThrow(/undefined/);
  });

  it('rejects an object rather than storing "[object Object]"', async () => {
    expect(
      () => DB.prepare('INSERT INTO t (id, name) VALUES (?, ?)').bind('t1', { a: 1 })
    ).toThrow(/D1_TYPE_ERROR/);
  });
});

describe('batch is a transaction, as it is on D1', () => {
  it('applies every statement together', async () => {
    await DB.batch([
      DB.prepare('INSERT INTO t (id, name) VALUES (?, ?)').bind('a', 'A'),
      DB.prepare('INSERT INTO t (id, name) VALUES (?, ?)').bind('b', 'B'),
    ]);
    const { results } = await DB.prepare('SELECT id FROM t ORDER BY id').all();
    expect(results.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('rolls the whole batch back when one statement fails', async () => {
    // An order and its lines go in as one batch. A half-applied batch is an
    // order on the kitchen board missing items nobody knows were ordered.
    await expect(
      DB.batch([
        DB.prepare('INSERT INTO t (id, name) VALUES (?, ?)').bind('a', 'A'),
        DB.prepare('INSERT INTO t (id, name) VALUES (?, ?)').bind('a', 'duplicate primary key'),
      ])
    ).rejects.toThrow();

    const { results } = await DB.prepare('SELECT id FROM t').all();
    expect(results).toEqual([]);
  });

  it('leaves the connection usable after a rolled-back batch', async () => {
    await expect(
      DB.batch([DB.prepare('INSERT INTO t (id) VALUES (?)').bind('a'), DB.prepare('INSERT INTO t (id) VALUES (?)').bind('a')])
    ).rejects.toThrow();

    // A stranded open transaction would fail the next write with
    // "cannot start a transaction within a transaction" — the till would take
    // one bad order and then refuse everything after it.
    await DB.prepare('INSERT INTO t (id, name) VALUES (?, ?)').bind('later', 'fine').run();
    expect(await DB.prepare('SELECT count(*) AS n FROM t').first('n')).toBe(1);
  });
});

describe('the database is configured for a service floor', () => {
  it('runs in WAL so the kitchen display can read while a waiter writes', () => {
    expect(String(db.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase()).toBe('wal');
  });

  it('enforces foreign keys, which D1 does and SQLite does not by default', () => {
    expect(db.prepare('PRAGMA foreign_keys').get().foreign_keys).toBe(1);
  });
});
