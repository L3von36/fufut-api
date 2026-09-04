import { mapResourceRow } from './resources.js';
import { d1Query } from '../lib/db.js';
import { alertVisibleTo, allowedRuleIdsForRole } from './alerts.js';

function sseEvent(event, data) {
  const enc = new TextEncoder();
  return enc.encode("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n");
}

/**
 * How long one isolate's query result stays fresh for every SSE client on the
 * channel. This is the read-budget fix.
 *
 * Before this cache, EVERY connected client ran its own broad query every
 * tick: ten tablets on the floor meant ten identical `SELECT ... FROM orders`
 * scans every ten seconds, all day — roughly two thirds of the D1 rows the
 * account read during service. With the cache, the first client to tick after
 * the freshness window refreshes the shared payload and everyone else reuses
 * it. Ten clients still see changes within one tick of each other; D1 sees
 * one query instead of ten.
 *
 * The window is deliberately a little shorter than the tick itself, so a
 * client's tick almost always finds a fresh cache rather than stacking two
 * queries back to back.
 */
const PAYLOAD_FRESH_MS = 8000;
const TICK_MS = 1e4;

/**
 * Per-isolate channel cache: channel name → { at, payload, sig, probe }.
 *
 * `probe` is the cheap change-detector's answer for the payload currently
 * cached; the next refresh re-runs the probe first and only falls through to
 * the broad query when the probe answer moved. The probes per channel:
 *
 *   kitchen  — MAX(updated_at) over active orders. Every mutating write to an
 *              order sets updated_at (status moves, item edits, table moves,
 *              voids, completion), and both INSERT paths now stamp it, so a
 *              single aggregate catches insert / edit / leave-the-board alike.
 *              Migration 027's partial index turns this into an index-tip
 *              read; before it applies the probe degrades to scanning the
 *              active set — never worse than the old code, and it only runs
 *              once per isolate per window instead of once per client.
 *   alerts   — COUNT(*) + MAX(COALESCE(updated_at, created)) over open rows.
 *              Inserts and acks/resolves move the count; the sweep's own
 *              severity/station/target updates stamp updated_at.
 *   activity — MAX(rowid) of audit_log. The log is append-only, so the tip
 *              rowid is a complete change detector, and SQLite answers it
 *              from the btree in O(1).
 *
 *   tables   — no probe: the table list is a few dozen rows, and the broad
 *              query itself is cheaper than any correct detector for rows
 *              whose status flips without a column the probe could trust.
 */
const channelCache = new Map();

const ACTIVE_ORDER_FILTER = "status NOT IN ('completed','cancelled','fulfilled')";

/** The cheap change-detector for a channel. Returns undefined = no probe. */
async function probeChannel(channel, env) {
  if (channel === 'kitchen') {
    const { results } = await d1Query(
      env,
      `SELECT MAX(updated_at) AS u FROM orders WHERE ${ACTIVE_ORDER_FILTER}`
    );
    return String((results || [])[0]?.u ?? '');
  }
  if (channel === 'alerts') {
    const { results } = await d1Query(
      env,
      "SELECT COUNT(*) AS n, MAX(COALESCE(updated_at, created)) AS u FROM alerts WHERE status = 'open'"
    );
    const r = (results || [])[0] || {};
    return `${r.n ?? 0}|${r.u ?? ''}`;
  }
  if (channel === 'activity') {
    const { results } = await d1Query(env, 'SELECT MAX(rowid) AS m FROM audit_log');
    return String((results || [])[0]?.m ?? '');
  }
  return undefined; // tables: always refresh
}

/** The broad query behind each channel — the exact queries the per-client
 *  ticks used to run, now run at most once per isolate per freshness window. */
async function broadQuery(channel, env) {
  if (channel === 'tables') {
    const { results } = await d1Query(env, 'SELECT * FROM tables ORDER BY created DESC');
    return { tables: (results || []).map((r) => mapResourceRow('tables', r)) };
  }
  if (channel === 'alerts') {
    // Broad, role-blind read: the per-client filter below applies the same
    // allowedRuleIdsForRole + alertVisibleTo pair the list endpoint uses, so
    // the shared payload never leaks — a chef's tablet still only ever
    // receives kitchen rows.
    const { results } = await d1Query(
      env,
      "SELECT * FROM alerts WHERE status = 'open' ORDER BY created DESC LIMIT 100"
    );
    return { alerts: results || [] };
  }
  if (channel === 'activity') {
    const { results } = await d1Query(
      env,
      'SELECT a.id, a.at, a.actor_id, a.actor_name, a.actor_role, a.action, a.entity, a.entity_id, a.reason, a.before, a.after' +
        ' FROM audit_log a ORDER BY a.at DESC LIMIT 50'
    );
    return { entries: results || [] };
  }
  // Kitchen tick: every active order on the board. Bounded because a busy
  // week puts thousands of rows in `orders` — see the original comment: 200
  // covers a full service day with headroom, and terminal states are what the
  // board does not need.
  const { results } = await d1Query(
    env,
    `SELECT * FROM orders WHERE ${ACTIVE_ORDER_FILTER} ORDER BY created DESC LIMIT 200`
  );
  const rows = (results || []).map((o) =>
    Object.assign({}, o, {
      tableNum: o.table_id || o.table_number || null,
      table_number: o.table_id || o.table_number || null,
    })
  );
  return { orders: rows };
}

const EVENT_NAMES = { tables: 'table_update', alerts: 'alerts_update', activity: 'activity_update', kitchen: 'new_order' };

/**
 * Tests run many channels against fresh databases in one process; without
 * this the previous test's cached payload would answer the next test's tick
 * — coalescing working exactly as designed, against the wrong database.
 */
function clearChannelCacheForTest() {
  channelCache.clear();
}

/**
 * One client's view of the shared payload: the role-targeted filter for the
 * alerts channel, the payload verbatim for everyone else.
 */
function clientView(channel, payload, client) {
  if (channel !== 'alerts') return payload;
  const rows = payload.alerts || [];
  if (client.managerSeesAll) return { alerts: rows };
  if (!client.allowedRules || client.allowedRules.length === 0) return { alerts: [] };
  return { alerts: rows.filter((r) => alertVisibleTo(r, client.auth)) };
}

/**
 * Advance a channel: refresh the shared cache if it is stale, then return
 * what THIS client should emit now.
 *
 * Exported for the tests, which drive ticks directly with an injected clock
 * instead of sleeping through real intervals. `handleSSE` calls it on the same
 * cadence the old per-client tick used, with the wall clock.
 */
export async function tickChannel(channel, env, client, opts = {}) {
  const nowMs = Number(opts.nowMs) || Date.now();
  let cache = channelCache.get(channel);

  if (!cache || nowMs - cache.at >= PAYLOAD_FRESH_MS) {
    try {
      const probe = await probeChannel(channel, env);
      if (cache && cache.payload && probe !== undefined && probe === cache.probe) {
        // Nothing moved — the cached payload stands. Stamp the timestamp so
        // the next client in this window reuses it without another probe.
        cache.at = nowMs;
      } else {
        const payload = await broadQuery(channel, env);
        cache = {
          at: nowMs,
          payload,
          sig: JSON.stringify(payload),
          probe,
        };
        channelCache.set(channel, cache);
      }
    } catch (e) {
      // A failing query leaves the last good payload standing and the cache
      // timestamp untouched, so the next tick retries. A client that just
      // connected during an outage gets a keepalive until D1 answers again.
    }
  }

  if (!cache || !cache.payload) return { keepaliveOnly: true };

  const view = clientView(channel, cache.payload, client);
  // The alerts view is per-client, so it needs its own signature; every other
  // channel hands the same payload to everyone and reuses the shared one.
  const sig = channel === 'alerts' ? JSON.stringify(view) : cache.sig;
  return { keepaliveOnly: false, sig, view };
}

async function handleSSE(request, env, channel, auth) {
  // The activity channel pushes recent audit_log entries (the live activity
  // feed for managers). Manager-only — non-managers get a 403.
  if (channel === 'activity') {
    const role = String((auth && (auth.sessionRole || auth.role)) || '').toLowerCase();
    if (role !== 'manager') {
      return new Response(JSON.stringify({ ok: false, error: 'Manager only' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  const alertsAllowedRules = channel === 'alerts' ? allowedRuleIdsForRole(auth) : [];
  const encoder = new TextEncoder();

  const client = {
    auth,
    allowedRules: alertsAllowedRules,
    managerSeesAll: alertsAllowedRules === null,
    // null = this client has not been sent anything yet — the first tick
    // always emits so a freshly connected screen gets the current state
    // rather than waiting for the floor to move.
    lastSig: null,
  };

  const stream = new ReadableStream({
    async start(controller) {
      const safe = (fn) => {
        try {
          fn();
        } catch (e) {}
      };
      const tick = async () => {
        try {
          const r = await tickChannel(channel, env, client);
          if (!r.keepaliveOnly && r.sig !== client.lastSig) {
            client.lastSig = r.sig;
            safe(() => controller.enqueue(sseEvent(EVENT_NAMES[channel], r.view)));
          }
        } catch (e) {}
        safe(() => controller.enqueue(encoder.encode(': keepalive\n\n')));
      };

      safe(() => controller.enqueue(sseEvent('connected', { ok: true, channel })));
      const timer = setInterval(tick, TICK_MS);
      tick();
      if (request && request.signal) {
        request.signal.addEventListener(
          'abort',
          () => {
            clearInterval(timer);
          },
          { once: true }
        );
      }
    },
    cancel() {
      // clearInterval happens in the abort listener; a cancelled stream with
      // no abort event is the closed-connection case the runtime already
      // surfaces through the signal on Workers. Nothing per-client lives in
      // module state, so there is nothing else to tear down.
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

export { sseEvent, handleSSE, PAYLOAD_FRESH_MS, TICK_MS, clearChannelCacheForTest };
