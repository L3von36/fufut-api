import { mapResourceRow } from './resources.js';
import { d1Query } from '../lib/db.js';

function sseEvent(event, data) {
  const enc = new TextEncoder();
  return enc.encode("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n");
}

async function handleSSE(request, env, channel) {
  const encoder = new TextEncoder();
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
            const { results } = await d1Query(env, "SELECT * FROM alerts WHERE status = 'open' ORDER BY created DESC LIMIT 100");
            eventName = "alerts_update";
            payload = { alerts: results || [] };
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
