/**
 * The sync protocol — phase 2 of stages 4 and 5.
 *
 * Three routes, all machine-to-machine, all authenticated by SYNC_TOKEN rather
 * than a staff session (see `authorizeSync` in auth.js):
 *
 *   POST /api/sync/push    the box hands over its journal
 *   GET  /api/sync/pull    the box collects this side's journal
 *   GET  /api/sync/status  liveness, and the heartbeat that decides whether
 *                          online ordering is open
 *
 * The same handler runs on both sides. The box is a Worker host, so "the cloud
 * side" is not special code — it is this code with SITE_ID set to 'cloud'.
 */

import { json, readBody, d1Query, d1Run } from '../lib/db.js';
import { decide, reasonFor } from '../lib/ownership.js';

/** Never hand over the whole journal at once; a reconnect after a long outage
 *  could otherwise be a single enormous request that times out and retries
 *  forever, making the outage permanent. */
const MAX_BATCH = 500;

/**
 * Replay one captured write, without journalling it again.
 *
 * `env.DB.prepare` directly rather than `d1Run`, and this is the whole reason
 * the two sides do not ping-pong: `d1Run` captures to the outbox, so a
 * replayed write would be journalled by the receiver, pushed back to the
 * sender, replayed there, journalled again, forever. Applied writes are
 * deliberately invisible to capture.
 */
async function replay(env, payload) {
  const sql = String(payload.sql || '');
  const params = Array.isArray(payload.params) ? payload.params : [];
  return await env.DB.prepare(sql).bind(...params).run();
}

function isDuplicate(err) {
  const text = String((err && err.message) || err);
  return /UNIQUE constraint|PRIMARY KEY|already exists/i.test(text);
}

async function recordConflict(env, siteId, entry, reason, winner) {
  await d1Run(
    env,
    `INSERT INTO sync_reconciliation
       (site_id, seq, entity, entity_id, op, payload, reason, winner, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      siteId,
      entry.seq ?? null,
      entry.entity,
      entry.entity_id ?? null,
      entry.op ?? null,
      typeof entry.payload === 'string' ? entry.payload : JSON.stringify(entry.payload ?? null),
      reason,
      winner,
      new Date().toISOString(),
    ]
  );
}

/**
 * Apply one entry under the ownership rules.
 *
 * Returns 'applied', 'duplicate' or 'conflict'. Nothing is ever dropped: a
 * refusal is written to `sync_reconciliation` before this returns.
 */
export async function applyEntry(env, siteId, entry, receiver) {
  const verdict = decide(entry.entity, entry.op, receiver);

  if (verdict === 'conflict') {
    await recordConflict(env, siteId, entry, reasonFor(entry.entity, entry.op, receiver), receiver);
    return 'conflict';
  }

  const payload = typeof entry.payload === 'string' ? JSON.parse(entry.payload) : entry.payload;

  try {
    const result = await replay(env, payload);

    /**
     * A replayed UPDATE that matched nothing is not success.
     *
     * The handlers write conditional updates — the atomic table claim is
     * `UPDATE tables SET ... WHERE id = ? AND status <> 'occupied'` — and a
     * condition re-evaluated against the receiver's state can quietly match
     * no rows. For a local-wins entity that means the cloud keeps a different
     * answer from the floor and nothing ever notices. Treated as a refusal so
     * it surfaces, which is the point of having a reconciliation list at all.
     */
    if (entry.op === 'update' && result && result.meta && result.meta.changes === 0) {
      await recordConflict(
        env,
        siteId,
        entry,
        'the update matched no rows on this side — the condition it carries was not true here',
        null
      );
      return 'conflict';
    }
    return 'applied';
  } catch (err) {
    // A retry after a dropped connection replays entries this side already
    // has. That is the protocol working, not a fault.
    if (isDuplicate(err)) return 'duplicate';
    await recordConflict(env, siteId, entry, `could not be applied: ${String(err.message || err)}`, null);
    return 'conflict';
  }
}

async function cursorRow(env, siteId, direction) {
  const { results } = await d1Query(
    env,
    'SELECT last_seq, epoch FROM sync_cursors WHERE site_id = ? AND direction = ?',
    [siteId, direction]
  );
  return (results && results[0]) || null;
}

export async function setCursor(env, siteId, direction, lastSeq, epoch = null) {
  await d1Run(
    env,
    `INSERT INTO sync_cursors (site_id, direction, last_seq, epoch, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (site_id, direction) DO UPDATE SET last_seq = excluded.last_seq,
       epoch = excluded.epoch, updated_at = excluded.updated_at`,
    [siteId, direction, lastSeq, epoch, new Date().toISOString()]
  );
}

/**
 * POST /api/sync/push — take the sender's journal.
 *
 * Idempotent by cursor: entries at or below what this side has already applied
 * are skipped without being replayed, so a push that succeeded but whose
 * response was lost can be sent again safely.
 */
async function handlePush(request, env, receiver) {
  const body = await readBody(request);
  if (!body || !Array.isArray(body.entries)) {
    return json({ ok: false, error: 'Expected { site_id, entries: [] }' }, 400);
  }

  const siteId = String(body.site_id || 'unknown');
  const epoch = body.epoch ? String(body.epoch) : null;
  const applied = { applied: 0, duplicate: 0, conflict: 0, skipped: 0 };

  /**
   * A journal that is not the one this cursor describes starts from nothing.
   *
   * `seq` restarts at 1 when a box is re-imaged or restored from backup. Judged
   * against the remembered cursor those fresh low numbers look like entries
   * already applied, and every one is skipped — silently, with no error and no
   * conflict, which is the worst way to lose a day's trading. Comparing the
   * epoch is what tells a new journal from a replayed one.
   */
  const known = await cursorRow(env, siteId, 'in');
  const rewound = Boolean(epoch && known && known.epoch && known.epoch !== epoch);
  let lastSeq = rewound ? 0 : (known && Number(known.last_seq)) || 0;

  // In seq order, always: "add the item" must not arrive after "mark it
  // served".
  const entries = [...body.entries].sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));

  for (const entry of entries) {
    const seq = Number(entry.seq || 0);
    if (seq && seq <= lastSeq) {
      applied.skipped += 1;
      continue;
    }
    const outcome = await applyEntry(env, siteId, entry, receiver);
    applied[outcome] += 1;
    // The cursor advances past a conflict too. It has been recorded for a
    // human, and leaving it in the way would stall every later entry behind a
    // decision nobody is waiting to make.
    if (seq) lastSeq = seq;
  }

  await setCursor(env, siteId, 'in', lastSeq, epoch);
  // `rewound` tells the sender its journal was recognised as a new one, which
  // is worth seeing in a log rather than inferring from counts.
  return json({ ok: true, last_seq: lastSeq, rewound, ...applied });
}

/** GET /api/sync/pull?since=N — hand over this side's journal. */
async function handlePull(url, env) {
  const since = Number(url.searchParams.get('since') || 0) || 0;
  const limit = Math.min(Number(url.searchParams.get('limit') || MAX_BATCH) || MAX_BATCH, MAX_BATCH);

  const { results } = await d1Query(
    env,
    'SELECT seq, entity, entity_id, op, payload, at FROM sync_outbox WHERE seq > ? ORDER BY seq LIMIT ?',
    [since, limit]
  );
  const entries = results || [];

  return json({
    ok: true,
    site_id: env.SITE_ID || null,
    entries,
    last_seq: entries.length ? entries[entries.length - 1].seq : since,
    // So the caller knows to come straight back rather than waiting for the
    // next poll — a long outage drains in a few seconds instead of minutes.
    more: entries.length === limit,
  });
}

/**
 * GET /api/sync/status — liveness, and the heartbeat.
 *
 * The box calls this every 30 seconds. The record it leaves is what the public
 * ordering page reads to decide whether to accept an order: with the venue
 * unreachable, an order taken online is one the kitchen will never see, and
 * telling the customer that ordering is briefly closed is the better failure.
 */
async function handleStatus(request, url, env) {
  const siteId = String(url.searchParams.get('site_id') || 'unknown');
  const nowIso = new Date().toISOString();

  if (siteId !== 'unknown') {
    await d1Run(
      env,
      `INSERT INTO venue_heartbeat (site_id, last_seen, detail) VALUES (?, ?, ?)
       ON CONFLICT (site_id) DO UPDATE SET last_seen = excluded.last_seen, detail = excluded.detail`,
      [siteId, nowIso, url.searchParams.get('detail') || null]
    );
  }

  const head = await d1Query(env, 'SELECT MAX(seq) AS head FROM sync_outbox');
  const open = await d1Query(env, 'SELECT count(*) AS n FROM sync_reconciliation WHERE resolved = 0');

  return json({
    ok: true,
    site_id: env.SITE_ID || null,
    now: nowIso,
    outbox_head: (head.results && head.results[0] && head.results[0].head) || 0,
    unresolved_conflicts: (open.results && open.results[0] && open.results[0].n) || 0,
  });
}

/**
 * GET /api/sync/reconciliation — what the rules refused.
 *
 * A staff route rather than a machine one, so it is reachable from the
 * backoffice with a manager session. The list is the whole point of the design
 * doc's insistence that nothing is silently dropped.
 */
async function handleReconciliation(url, env) {
  const includeResolved = url.searchParams.get('all') === 'true';
  const { results } = await d1Query(
    env,
    `SELECT * FROM sync_reconciliation ${includeResolved ? '' : 'WHERE resolved = 0'}
     ORDER BY created_at DESC LIMIT 200`
  );
  return json({ ok: true, entries: results || [] });
}

export async function handleSync(pathname, method, url, request, env, auth) {
  const receiver = env.SITE_ID || 'cloud';
  const upper = String(method).toUpperCase();

  if (pathname === '/api/sync/push' && upper === 'POST') return handlePush(request, env, receiver);
  if (pathname === '/api/sync/pull' && upper === 'GET') return handlePull(url, env);
  if (pathname === '/api/sync/status' && upper === 'GET') return handleStatus(request, url, env);
  if (pathname === '/api/sync/reconciliation' && upper === 'GET') return handleReconciliation(url, env);

  return json({ ok: false, error: 'Not found' }, 404);
}
