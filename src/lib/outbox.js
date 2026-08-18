/**
 * The sync outbox — every write, journaled for the other side.
 *
 * Stages 4 and 5 of LOCAL-SERVER-DESIGN.md: the box and the cloud are two
 * writers with different jobs, and each needs to see the other's writes.
 * Rather than instrumenting ~80 handler call sites, the journal hooks the two
 * choke points every write already passes through — `d1Run` and `d1Batch` in
 * `src/lib/db.js` — and records the SQL verbatim.
 *
 * Verbatim SQL, not a reconstructed row, is deliberate. The handlers build
 * dynamic SET lists, dynamic column lists and conditional columns; any
 * re-interpretation of those here would be a second implementation of the
 * write path, and the two would drift exactly when it matters — mid-replay,
 * during a reconnect. The receiving side runs the same statement through the
 * same `d1Run`, so replay is the original write, not a paraphrase of it.
 *
 * Capture is fail-open: if the journal cannot be written, the write it
 * accompanied has already happened and must not be rolled back over a sync
 * concern — a till that stops taking orders because its sync journal is full
 * has its priorities backwards. The failure is logged (once per process, not
 * once per write) and the entry is lost to sync; the nightly backup and the
 * audit log remain as backstops.
 */

/**
 * Tables whose writes are site-local and never cross.
 *
 * - `sessions`: auth state for whichever side issued it. A token that works
 *   on the box must not work on the cloud; that is the point of the boundary.
 * - `sync_*` and `venue_heartbeat`: the protocol's own bookkeeping. Journalling
 *   it would make the journal recursive — and the heartbeat is written every
 *   thirty seconds, so capturing it would have the cloud handing the box ~2,880
 *   entries a day that say nothing except that the box is alive, which the box
 *   already knows.
 * - `d1_migrations`: each side manages its own schema.
 * - `_cf_KV`: the local KV shim's storage. On the cloud these namespaces are
 *   real Cloudflare KV, not D1 rows, so there is nothing on the other side
 *   for a captured row to land in. Content in KV stays cloud-authoritative.
 */
const EXCLUDED = new Set([
  'sessions', 'sync_outbox', 'sync_cursors', 'sync_reconciliation', 'venue_heartbeat',
  'd1_migrations', '_cf_kv',
]);

const WRITE_RE = /^\s*(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/i;
const ID_EQ_RE = /(?:^|[\s(])id\s*=\s*\?/i;

/**
 * { op, table } for a write statement, or null for anything else — reads,
 * PRAGMAs, or a shape this parser does not recognise. Unrecognised is not
 * captured: silence here means the write still happens, it just does not
 * sync, which is the safe direction for a parser to fail.
 */
export function extractWrite(sql) {
  const match = WRITE_RE.exec(String(sql));
  if (!match) return null;
  const op = match[1].toUpperCase().startsWith('INSERT') ? 'insert'
    : match[1].toUpperCase().startsWith('UPDATE') ? 'update' : 'delete';
  return { op, table: match[2].toLowerCase() };
}

/**
 * The id of the row a statement touches, or null when it cannot be told.
 *
 * Ordering during replay is per entity in seq order, so the id is what makes
 * "add the item, then mark it served" survive the crossing. A null id does
 * not drop the entry — it only coarsens its ordering to the global seq.
 */
export function extractEntityId(sql, params, op) {
  const text = String(sql);
  const list = Array.isArray(params) ? params : [];
  try {
    if (op === 'insert') {
      // The column list is the first parenthesised group after the table
      // name. Handlers build it dynamically, but capture sees the finished
      // statement, so the list is always literal by the time it arrives.
      const open = text.indexOf('(');
      const close = open === -1 ? -1 : text.indexOf(')', open);
      if (open === -1 || close === -1) return null;
      const columns = text.slice(open + 1, close).split(',').map((c) => c.trim().replace(/^"|"$/g, '').toLowerCase());
      const at = columns.indexOf('id');
      return at === -1 || at >= list.length ? null : String(list[at] ?? '') || null;
    }
    // UPDATE / DELETE: `id = ?` is the Nth placeholder in the statement —
    // counting the ones before it handles SET lists that also bind values.
    const match = ID_EQ_RE.exec(text);
    if (!match) return null;
    const upTo = text.slice(0, match.index + match[0].length);
    const nth = (upTo.match(/\?/g) || []).length;
    return nth >= 1 && nth <= list.length ? String(list[nth - 1] ?? '') || null : null;
  } catch {
    return null;
  }
}

/** JSON that cannot throw on a BigInt slipping through as a bind param. */
function serialize(payload) {
  return JSON.stringify(payload, (_key, value) => {
    if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : String(value);
    return value;
  });
}

let warned = false;

/**
 * Journal one write. Called after the write succeeded, on the same
 * connection, so on the box a captured batch entry lives inside the batch's
 * transaction and rolls back with it. No-op unless SITE_ID is set — the
 * deployed cloud Worker today runs without it and must be byte-for-byte
 * unaffected until sync is deliberately switched on.
 */
export async function outboxCapture(env, sql, params) {
  if (!env || !env.SITE_ID) return;
  let write;
  try {
    write = extractWrite(sql);
    if (!write || EXCLUDED.has(write.table)) return;
    const entityId = extractEntityId(sql, params, write.op);
    await env.DB.prepare(
      'INSERT INTO sync_outbox (entity, entity_id, op, payload, at) VALUES (?, ?, ?, ?, ?)'
    ).bind(write.table, entityId, write.op, serialize({ sql: String(sql), params: params ?? [] }), new Date().toISOString()).run();
  } catch (err) {
    // Fail-open, and loud once rather than on every write through a busy
    // service. See the module comment for why the write is not undone.
    if (!warned) {
      warned = true;
      console.error('[sync] outbox capture failed (writes continue; affected entries will not sync):', err);
    }
  }
}

/**
 * Prepared outbox inserts for a batch, so the journal lands inside the same
 * transaction as the writes it describes — on the box via the adapter's
 * BEGIN/COMMIT, on D1 because a batch is atomic there too. An empty array
 * when capture is off, leaving the batch untouched.
 */
export function outboxBatchStatements(env, entries) {
  if (!env || !env.SITE_ID) return [];
  const out = [];
  for (const { sql, params } of entries) {
    const write = extractWrite(sql);
    if (!write || EXCLUDED.has(write.table)) continue;
    const entityId = extractEntityId(sql, params, write.op);
    try {
      out.push(
        env.DB.prepare(
          'INSERT INTO sync_outbox (entity, entity_id, op, payload, at) VALUES (?, ?, ?, ?, ?)'
        ).bind(write.table, entityId, write.op, serialize({ sql: String(sql), params: params ?? [] }), new Date().toISOString())
      );
    } catch {
      // A param the adapter refuses to pre-bind (undefined, an object).
      // The write itself will fail the same way inside the batch, so there
      // is nothing to journal.
    }
  }
  return out;
}
