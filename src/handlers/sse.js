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
      const safe = /* @__PURE__ */ __name((fn) => {
        try {
          fn();
        } catch (e) {
        }
      }, "safe");
      const tick = /* @__PURE__ */ __name(async () => {
        try {
          let eventName;
          let payload;
          if (channel === "tables") {
            const { results } = await d1Query(env, "SELECT * FROM tables ORDER BY created DESC");
            eventName = "table_update";
            payload = { tables: (results || []).map((r) => mapResourceRow("tables", r)) };
          } else {
            const { results } = await d1Query(env, "SELECT * FROM orders WHERE status NOT IN ('completed','cancelled','fulfilled') ORDER BY created DESC");
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
      }, "tick");
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
