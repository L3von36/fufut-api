import { mapResourceRow } from './resources.js';
import { d1Query } from '../lib/db.js';

function sseEvent(event, data) {
  const enc = new TextEncoder();
  return enc.encode("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n");
}

async function handleSSE(request, env, channel) {
  const encoder = new TextEncoder();
  let timer = null;
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
          if (channel === "tables") {
            const { results } = await d1Query(env, "SELECT * FROM tables ORDER BY created DESC");
            safe(() => controller.enqueue(sseEvent("table_update", { tables: (results || []).map((r) => mapResourceRow("tables", r)) })));
          } else {
            const { results } = await d1Query(env, "SELECT * FROM orders WHERE status NOT IN ('completed','cancelled','fulfilled') ORDER BY created DESC");
            const rows = (results || []).map((o) => Object.assign({}, o, { tableNum: o.table_id || o.table_number || null, table_number: o.table_id || o.table_number || null }));
            safe(() => controller.enqueue(sseEvent("new_order", { orders: rows })));
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
