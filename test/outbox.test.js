/**
 * The sync outbox — phase 1 of stages 4 and 5.
 *
 * Tested against real SQLite through the local adapter rather than a mock,
 * because the thing being claimed is that ordinary writes made by ordinary
 * handlers land in the journal. A mocked `env.DB` would only prove that the
 * capture function calls the mock.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openLocalD1 } from '../local/d1.js';
import { applySchema } from '../local/env.js';
import { d1Run, d1Batch } from '../src/lib/db.js';
import { extractWrite, extractEntityId } from '../src/lib/outbox.js';

let dir;
let db;
let env;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fufut-outbox-'));
  const opened = openLocalD1(path.join(dir, 'test.sqlite'));
  db = opened.db;
  applySchema(db);
  env = { DB: opened.DB, SITE_ID: 'local' };
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const outbox = () => db.prepare('SELECT * FROM sync_outbox ORDER BY seq').all();

describe('reading a write statement', () => {
  it('names the operation and the table', () => {
    expect(extractWrite('INSERT INTO orders (id) VALUES (?)')).toEqual({ op: 'insert', table: 'orders' });
    expect(extractWrite('UPDATE tables SET status = ? WHERE id = ?')).toEqual({ op: 'update', table: 'tables' });
    expect(extractWrite('DELETE FROM order_items WHERE id = ?')).toEqual({ op: 'delete', table: 'order_items' });
  });

  it('ignores anything that is not a write', () => {
    // Failing to recognise a statement means it does not sync. Mistaking a
    // read for a write would put nonsense on the wire, so the parser is
    // deliberately narrow.
    expect(extractWrite('SELECT * FROM orders')).toBeNull();
    expect(extractWrite('PRAGMA table_info(orders)')).toBeNull();
  });
});

describe('finding the row an entry is about', () => {
  it('reads the id out of an insert by column position', () => {
    const sql = 'INSERT INTO orders (id, total, status) VALUES (?, ?, ?)';
    expect(extractEntityId(sql, ['O123', 260, 'new'], 'insert')).toBe('O123');
  });

  it('finds it when id is not the first column', () => {
    const sql = 'INSERT INTO order_items (order_id, id, name) VALUES (?, ?, ?)';
    expect(extractEntityId(sql, ['O1', 'OI9', 'Buna'], 'insert')).toBe('OI9');
  });

  it('counts placeholders so a SET list does not shift the id', () => {
    // The trap: `id = ?` is the third placeholder here, not the first.
    const sql = 'UPDATE orders SET status = ?, total = ? WHERE id = ?';
    expect(extractEntityId(sql, ['ready', 300, 'O123'], 'update')).toBe('O123');
  });

  it('returns null rather than guessing on a bulk update', () => {
    // Ordering falls back to the global seq, which is correct but coarser —
    // better than attributing the write to a row it does not touch.
    const sql = "UPDATE tables SET status = 'available' WHERE seated_at < ?";
    expect(extractEntityId(sql, ['2026-01-01'], 'update')).toBeNull();
  });
});

describe('ordinary writes are journalled', () => {
  it('captures an insert with its statement and parameters', async () => {
    await d1Run(env, 'INSERT INTO tables (id, number, status) VALUES (?, ?, ?)', ['7', 7, 'available']);

    const entries = outbox();
    expect(entries).toHaveLength(1);
    expect(entries[0].entity).toBe('tables');
    expect(entries[0].entity_id).toBe('7');
    expect(entries[0].op).toBe('insert');

    // The payload has to be enough to replay the write on the other side.
    const payload = JSON.parse(entries[0].payload);
    expect(payload.sql).toContain('INSERT INTO tables');
    expect(payload.params).toEqual(['7', 7, 'available']);
  });

  it('captures updates and deletes', async () => {
    await d1Run(env, 'INSERT INTO tables (id, number, status) VALUES (?, ?, ?)', ['7', 7, 'available']);
    await d1Run(env, 'UPDATE tables SET status = ? WHERE id = ?', ['occupied', '7']);
    await d1Run(env, 'DELETE FROM tables WHERE id = ?', ['7']);

    expect(outbox().map((e) => e.op)).toEqual(['insert', 'update', 'delete']);
  });

  it('keeps seq monotonic, because replay depends on the order', async () => {
    for (const status of ['new', 'preparing', 'ready']) {
      await d1Run(env, 'INSERT INTO orders (id, items, status, total) VALUES (?, ?, ?, ?)', ['O' + status, '[]', status, 1]);
    }
    const seqs = outbox().map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});

describe('batches are journalled inside their own transaction', () => {
  it('captures every statement in the batch', async () => {
    await d1Batch(env, [
      { sql: 'INSERT INTO order_items (id, order_id, name, qty) VALUES (?, ?, ?, ?)', params: ['OI1', 'O1', 'Buna', 2] },
      { sql: 'INSERT INTO order_items (id, order_id, name, qty) VALUES (?, ?, ?, ?)', params: ['OI2', 'O1', 'Gebeta', 1] },
    ]);

    const entries = outbox();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.entity_id)).toEqual(['OI1', 'OI2']);
  });

  it('rolls the journal back with the writes when the batch fails', async () => {
    // An order that reached the kitchen here but never appeared on the other
    // side would be the worst of both worlds. The journal has to share the
    // transaction, not merely follow it.
    await expect(
      d1Batch(env, [
        { sql: 'INSERT INTO order_items (id, order_id, name) VALUES (?, ?, ?)', params: ['OI1', 'O1', 'Buna'] },
        { sql: 'INSERT INTO order_items (id, order_id, name) VALUES (?, ?, ?)', params: ['OI1', 'O1', 'duplicate id'] },
      ])
    ).rejects.toThrow();

    expect(outbox()).toEqual([]);
    expect(db.prepare('SELECT count(*) AS n FROM order_items').get().n).toBe(0);
  });
});

describe('what never crosses', () => {
  it('does not journal sessions', async () => {
    // A session issued by the box must not become a session on the cloud.
    // That boundary is the point of having two sides.
    await d1Run(env, 'INSERT INTO sessions (token, staff_id, expires_at) VALUES (?, ?, ?)', ['t1', 'S1', 'later']);
    expect(outbox()).toEqual([]);
  });

  it('does not journal its own bookkeeping', async () => {
    await d1Run(env, 'INSERT INTO sync_cursors (site_id, direction, last_seq, updated_at) VALUES (?, ?, ?, ?)', [
      'cloud', 'push', 5, 'now',
    ]);
    expect(outbox()).toEqual([]);
  });
});

describe('capture is off until a side is given an identity', () => {
  it('writes nothing when SITE_ID is unset', async () => {
    // This is what keeps the deployed cloud Worker byte-for-byte unaffected
    // until sync is deliberately switched on.
    const anonymous = { DB: env.DB };
    await d1Run(anonymous, 'INSERT INTO tables (id, number, status) VALUES (?, ?, ?)', ['8', 8, 'available']);

    expect(outbox()).toEqual([]);
    expect(db.prepare('SELECT count(*) AS n FROM tables').get().n).toBe(1);
  });
});

describe('a broken journal never stops the till', () => {
  it('lets the write stand when capture fails', async () => {
    // A cafe that stops taking orders because its sync journal is unhappy has
    // its priorities backwards. The write has already happened by then.
    db.exec('DROP TABLE sync_outbox');
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      d1Run(env, 'INSERT INTO tables (id, number, status) VALUES (?, ?, ?)', ['9', 9, 'available'])
    ).resolves.toBeDefined();

    expect(db.prepare('SELECT count(*) AS n FROM tables').get().n).toBe(1);
    warn.mockRestore();
  });
});
