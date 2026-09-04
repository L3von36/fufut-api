import { mapResourceRow } from './resources.js';
import { d1Query } from '../lib/db.js';
import { alertVisibleTo, allowedRuleIdsForRole } from './alerts.js';

function sseEvent(event, data) {
  const enc = new TextEncoder();
  return enc.encode("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n");
}

async function handleSSE(request, env, channel, auth) {
  // The alerts channel must apply the same role-targeted filter as
  // GET /api/alerts — otherwise a chef's tablet would see every open alert
  // pushed via SSE even though listAlerts correctly returns 0 to them. The
  // pre-filter (allowedRuleIdsForRole) returns null for a manager (sees
  // everything) or an array of allowed rule_ids; the per-row refinement
  // (station, targeted pings) is the same alertVisibleTo the list endpoint
  // uses, so the two surfaces can never disagree about who saw what.
  const alertsAllowedRules = (channel === 'alerts') ? allowedRuleIdsForRole(auth) : [];
  const alertsManagerSeesAll = alertsAllowedRules === null;
  const encoder = new TextEncoder();

  // The activity channel pushes recent audit_log entries (the live activity
  // feed for managers). Manager-only — non-managers get a 403.
  const isActivityChannel = channel === 'activity';
  if (isActivityChannel) {
    const role = String((auth && (auth.sessionRole || auth.role)) || '').toLowerCase();
    if (role !== 'manager') {
      return new Response(JSON.stringify({ ok: false, error: 'Manager only' }), {
        status: 403, headers: { 'Content-Type': 'application/json' },
      });
    }
  }
  let timer = null;
  // The last payload sent, so a tick that found nothing new stays quiet.
  // Previously every tick emitted, which made the stream a 10-second poll in
  // disguise: a screen could not subscribe and refresh on the event without
  // refetching ten times a minute forever. Only the keepalive is unconditional.
  let lastSignature = null;
  const stream = new ReadableStream({
    async start(controller) {
      const safe = (fn) => {
        try {
          fn();
        } catch (e) {
        }
      };
      const tick = async () => {
        try {
          let eventName;
          let payload;
          if (channel === "tables") {
            const { results } = await d1Query(env, "SELECT * FROM tables ORDER BY created DESC");
            eventName = "table_update";
            payload = { tables: (results || []).map((r) => mapResourceRow("tables", r)) };
          } else if (channel === "alerts") {
            // Open alerts only: a resolved or acknowledged alert leaving the
            // feed is the point — the banner goes away when the floor fixes it.
            // Filtered by the caller's role so a chef's banner only sees
            // kitchen-relevant rules (preparing-too-long, new-unaccepted,
            // ready-not-served) — same filter as GET /api/alerts. Station and
            // per-person targeting are applied per row below; without all of
            // this the SSE push would leak every open alert to every tablet.
            let rows;
            if (alertsManagerSeesAll) {
              ({ results: rows } = await d1Query(env, "SELECT * FROM alerts WHERE status = 'open' ORDER BY created DESC LIMIT 100"));
            } else if (alertsAllowedRules && alertsAllowedRules.length === 0) {
              rows = [];
            } else {
              const placeholders = alertsAllowedRules.map(() => '?').join(',');
              ({ results: rows } = await d1Query(
                env,
                `SELECT * FROM alerts WHERE status = 'open' AND rule_id IN (${placeholders}) ORDER BY created DESC LIMIT 100`,
                alertsAllowedRules
              ));
            }
            const visible = (rows || []).filter((r) => alertVisibleTo(r, auth));
            eventName = "alerts_update";
            payload = { alerts: visible };
          } else if (isActivityChannel) {
            // Live activity feed: pushes the 50 most recent audit_log entries
            // to managers every 10s. Manager-only — checked at the top of
            // handleSSE (returns 403 for non-managers). The signature dedup
            // means no event is emitted when nothing has changed.
            const { results } = await d1Query(env,
              "SELECT a.id, a.at, a.actor_id, a.actor_name, a.actor_role, a.action, a.entity, a.entity_id, a.reason, a.before, a.after" +
              " FROM audit_log a ORDER BY a.at DESC LIMIT 50"
            );
            eventName = "activity_update";
            payload = { entries: results || [] };
          } else {
            // Kitchen tick: every active order on the board. Bounded because a
            // busy week puts thousands of rows in `orders`, and every connected
            // kitchen/pipeline client runs this query every 10s — without a
            // LIMIT the SSE tick becomes a full-table scan that grows linearly
            // with the order history, and the per-tick latency grows with it.
            // 200 covers a full service day with headroom; older history is
            // not what the kitchen board needs anyway (terminal states are
            // filtered out below, and the board is interested in what is open
            // *right now*).
            const { results } = await d1Query(env, "SELECT * FROM orders WHERE status NOT IN ('completed','cancelled','fulfilled') ORDER BY created DESC LIMIT 200");
            const rows = (results || []).map((o) => Object.assign({}, o, { tableNum: o.table_id || o.table_number || null, table_number: o.table_id || o.table_number || null }));
            eventName = "new_order";
            payload = { orders: rows };
          }
          const signature = JSON.stringify(payload);
          // The first tick always emits, so a screen that has just connected
          // gets the current state rather than waiting for the floor to move.
          if (signature !== lastSignature) {
            lastSignature = signature;
            safe(() => controller.enqueue(sseEvent(eventName, payload)));
          }
        } catch (e) {
        }
        safe(() => controller.enqueue(encoder.encode(": keepalive\n\n")));
      };
      safe(() => controller.enqueue(sseEvent("connected", { ok: true, channel })));
      timer = setInterval(tick, 1e4);
      tick();
      if (request && request.signal) {
        request.signal.addEventListener("abort", () => {
          if (timer) clearInterval(timer);
        }, { once: true });
      }
    },
    cancel() {
      if (timer) clearInterval(timer);
    }
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    }
  });
}
export { sseEvent, handleSSE };
