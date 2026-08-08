import { d1Run, json } from '../lib/db.js';

async function handleMigration(request, env) {
  const m = request.method.toUpperCase();
  const path = new URL(request.url).pathname;
  if (path === "/api/migrate/kv-to-d1" && m === "POST") {
    const results = { orders: 0, reservations: 0, reviews: 0, errors: [] };
    try {
      const orderNs = env.ORDERS_KV;
      if (orderNs) {
        const raw = await orderNs.get("data");
        if (raw) {
          const orders = JSON.parse(raw);
          for (const o of orders) {
            try {
              const id = o.id || "O" + crypto.randomUUID().slice(0, 7);
              const items = typeof o.items === "string" ? o.items : JSON.stringify(o.items || []);
              await d1Run(
                env,
                "INSERT OR IGNORE INTO orders (id, items, total, payment, type, table_id, customer, status, email) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [id, items, o.total || 0, o.payment || null, o.order_type || o.type || null, o.table_number || o.table_id || null, o.name || o.customer || null, o.status || "new", o.email || ""]
              );
              results.orders++;
            } catch (e) {
              results.errors.push("order:" + (o.id || "?") + ":" + e.message);
            }
          }
        }
      }
    } catch (e) {
      results.errors.push("orders_bulk:" + e.message);
    }
    try {
      const resNs = env.RESERVATIONS_KV;
      if (resNs) {
        const raw = await resNs.get("data");
        if (raw) {
          const reservations = JSON.parse(raw);
          for (const r of reservations) {
            try {
              const id = r.id || "R" + crypto.randomUUID().slice(0, 7);
              await d1Run(
                env,
                "INSERT OR IGNORE INTO reservations (id, name, phone, email, date, time, guests, table_id, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [id, r.name || "", r.phone || "", r.email || "", r.date || "", r.time || "", r.guests || 1, r.tableId || r.table_id || "", r.status || "new", r.notes || ""]
              );
              results.reservations++;
            } catch (e) {
              results.errors.push("reservation:" + (r.id || "?") + ":" + e.message);
            }
          }
        }
      }
    } catch (e) {
      results.errors.push("reservations_bulk:" + e.message);
    }
    try {
      const revNs = env.REVIEWS_KV;
      if (revNs) {
        const raw = await revNs.get("data");
        if (raw) {
          const reviews = JSON.parse(raw);
          for (const r of reviews) {
            try {
              const id = r.id || "RV" + crypto.randomUUID().slice(0, 7);
              await d1Run(
                env,
                "INSERT OR IGNORE INTO reviews (id, author, text, rating, status, date) VALUES (?, ?, ?, ?, ?, ?)",
                [id, r.author || r.name || "", r.text || r.review || "", r.rating || 5, r.status || "pending", r.date || (/* @__PURE__ */ new Date()).toISOString().split("T")[0]]
              );
              results.reviews++;
            } catch (e) {
              results.errors.push("review:" + (r.id || "?") + ":" + e.message);
            }
          }
        }
      }
    } catch (e) {
      results.errors.push("reviews_bulk:" + e.message);
    }
    return json(results);
  }
  return null;
}
export { handleMigration };
