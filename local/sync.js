/**
 * The sync daemon — phase 3 of stages 4 and 5.
 *
 * Runs on the box, every 30 seconds: check the cloud is reachable, push this
 * side's journal, pull the cloud's, apply it under the ownership rules.
 *
 * It deliberately does NOT contain a second implementation of "apply an
 * entry". `applyEntry` is imported from the cloud-side handler and runs here
 * unchanged, so both directions go through one code path and one set of
 * ownership rules. The alternative — a box-side apply that looks like the
 * cloud's — is exactly the drift this whole design is trying to avoid, and it
 * would show up as data loss during a reconnect rather than as a failing test.
 *
 * The daemon is inert unless CLOUD_URL and SYNC_TOKEN are both set. A box with
 * neither journals locally and talks to nobody, which is stage 3's behaviour.
 */

import { applyEntry, setCursor } from '../src/handlers/sync.js';
import { d1Query, d1Run } from '../src/lib/db.js';

/** Matches the cloud handler's cap: a reconnect after a long outage must not
 *  become one enormous request that times out and retries forever. */
const BATCH = 500;
/** Bound the drain so a runaway peer cannot hold the loop open indefinitely. */
const MAX_ROUNDS = 20;
const REQUEST_TIMEOUT_MS = 10_000;
export const SYNC_INTERVAL_MS = 30_000;

/**
 * Journal entries are kept for a week after both sides have acknowledged them,
 * then pruned. A box that trades for a year would otherwise carry every write
 * it has ever made, and the one thing it cannot afford is to fill its own disk.
 * The week is there so a problem noticed on Monday can still be traced back
 * through the weekend.
 */
const RETAIN_ACKED_MS = 7 * 24 * 60 * 60 * 1000;

async function cursor(env, siteId, direction) {
  const { results } = await d1Query(
    env,
    'SELECT last_seq FROM sync_cursors WHERE site_id = ? AND direction = ?',
    [siteId, direction]
  );
  return (results && results[0] && Number(results[0].last_seq)) || 0;
}

/**
 * One round trip to the cloud.
 *
 * Errors are returned rather than thrown: an unreachable cloud is the normal
 * condition this whole project exists for, not an exception.
 */
export function createSyncEngine({ env, fetchImpl, now = () => Date.now() }) {
  const doFetch = fetchImpl || globalThis.fetch;
  const peer = 'cloud';
  const me = env.SITE_ID || 'local';

  let online = null; // null = not yet known, so the first result always logs
  let running = false;
  let timer = null;

  function configured() {
    return Boolean(env.CLOUD_URL && env.SYNC_TOKEN);
  }

  async function request(pathAndQuery, init = {}) {
    const url = String(env.CLOUD_URL).replace(/\/$/, '') + pathAndQuery;
    const response = await doFetch(url, {
      ...init,
      headers: {
        Authorization: 'Bearer ' + env.SYNC_TOKEN,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`${init.method || 'GET'} ${pathAndQuery} → ${response.status}`);
    }
    return await response.json();
  }

  /** Send everything the cloud has not acknowledged. */
  async function push() {
    let sent = 0;
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const since = await cursor(env, peer, 'out');
      const { results } = await d1Query(
        env,
        'SELECT seq, entity, entity_id, op, payload, at FROM sync_outbox WHERE seq > ? ORDER BY seq LIMIT ?',
        [since, BATCH]
      );
      const entries = results || [];
      if (!entries.length) break;

      const answer = await request('/api/sync/push', {
        method: 'POST',
        body: JSON.stringify({ site_id: me, entries }),
      });

      // Trust the cloud's acknowledgement rather than what we sent: if it
      // applied less than it was given, the rest must be sent again.
      const acked = Number(answer.last_seq || 0);
      if (acked <= since) break; // no progress; stop rather than spin
      await setCursor(env, peer, 'out', acked);
      sent += entries.filter((e) => e.seq <= acked).length;
      if (entries.length < BATCH) break;
    }
    return sent;
  }

  /** Collect and apply everything the cloud has that this box has not seen. */
  async function pull() {
    let applied = 0;
    let conflicts = 0;
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const since = await cursor(env, peer, 'in');
      const answer = await request(`/api/sync/pull?since=${since}&limit=${BATCH}`);
      const entries = answer.entries || [];
      if (!entries.length) break;

      let last = since;
      for (const item of entries) {
        const outcome = await applyEntry(env, peer, item, me);
        if (outcome === 'applied') applied += 1;
        if (outcome === 'conflict') conflicts += 1;
        last = Number(item.seq) || last;
      }
      await setCursor(env, peer, 'in', last);
      if (!answer.more) break;
    }
    return { applied, conflicts };
  }

  /** Drop journal entries both sides are long done with. */
  async function prune() {
    const acked = await cursor(env, peer, 'out');
    if (!acked) return 0;
    const cutoff = new Date(now() - RETAIN_ACKED_MS).toISOString();
    const result = await d1Run(env, 'DELETE FROM sync_outbox WHERE seq <= ? AND at < ?', [acked, cutoff]);
    return (result && result.meta && result.meta.changes) || 0;
  }

  /**
   * One full cycle. Never throws: this runs on a timer on a box nobody is
   * watching, and an exception escaping here would end the loop for good.
   */
  async function runOnce() {
    if (!configured()) return { skipped: 'not configured' };

    try {
      await request(`/api/sync/status?site_id=${encodeURIComponent(me)}`);
    } catch (err) {
      if (online !== false) {
        online = false;
        // Logged on the transition only. A box offline for two days should not
        // write 5,760 identical lines to its own disk.
        console.log(`[fufut] sync: cloud unreachable (${err.message}) — the room carries on; queued writes will keep`);
      }
      return { online: false };
    }

    if (online !== true) {
      online = true;
      console.log('[fufut] sync: cloud reachable');
    }

    try {
      const pushed = await push();
      const { applied, conflicts } = await pull();
      const pruned = await prune();

      if (pushed || applied || conflicts) {
        console.log(
          `[fufut] sync: pushed ${pushed}, pulled ${applied}, ${conflicts} conflict${conflicts === 1 ? '' : 's'}` +
            (pruned ? `, pruned ${pruned}` : '')
        );
      }
      if (conflicts) {
        console.log('[fufut] sync: conflicts need a manager — GET /api/sync/reconciliation');
      }
      return { online: true, pushed, applied, conflicts, pruned };
    } catch (err) {
      // Reachable but the exchange failed. Worth saying every time, because
      // unlike an outage this is not expected.
      console.error('[fufut] sync: exchange failed:', err.message);
      return { online: true, error: err.message };
    }
  }

  function start() {
    if (!configured()) {
      console.log('[fufut] sync: off — set CLOUD_URL and SYNC_TOKEN to connect this box to the cloud');
      return null;
    }
    console.log(`[fufut] sync: every ${SYNC_INTERVAL_MS / 1000}s with ${env.CLOUD_URL}`);
    timer = setInterval(async () => {
      if (running) return; // A slow exchange must not stack up behind itself.
      running = true;
      try {
        await runOnce();
      } finally {
        running = false;
      }
    }, SYNC_INTERVAL_MS);
    return timer;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { runOnce, start, stop, push, pull, prune, isConfigured: configured };
}
