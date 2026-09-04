import { d1Run, d1Query, json } from '../lib/db.js';
import { kvGetMenu, kvSaveMenu, isCategorized, backfillMenuIdsFromD1 } from './menu.js';

async function handleMigration(request, env) {
  const m = request.method.toUpperCase();
  const path = new URL(request.url).pathname;

  // One-shot: apply the four additive ALTER statements from migration 020
  // (B+ simulation findings). Safe to call repeatedly — each ALTER fails
  // silently on "duplicate column name", which means it already applied.
  // Manager-only via the /api/migrate/ prefix rule in auth.js.
  if (path === "/api/migrate/bplus-020" && m === "POST") {
    const statements = [
      "ALTER TABLE reservations ADD COLUMN order_id TEXT",
      "ALTER TABLE reservations ADD COLUMN completed_at TEXT",
      "ALTER TABLE cashdrawers ADD COLUMN paid_in REAL DEFAULT 0",
      "ALTER TABLE cashdrawers ADD COLUMN paid_out REAL DEFAULT 0",
      "ALTER TABLE orders ADD COLUMN void_category TEXT",
      "CREATE INDEX IF NOT EXISTS idx_reservations_order ON reservations(order_id) WHERE order_id IS NOT NULL AND order_id <> ''",
    ];
    const applied = [];
    const skipped = [];
    for (const sql of statements) {
      try {
        await d1Run(env, sql);
        applied.push(sql);
      } catch (e) {
        // SQLite "duplicate column name" / "index already exists" — expected.
        skipped.push({ sql, reason: String(e.message || e) });
      }
    }
    return json({ ok: true, applied, skipped });
  }

  // One-shot: apply migration 021 — stamp when a drawer session was closed,
  // so the Z-Report History can show a close time instead of reusing the
  // opened timestamp. Idempotent for the same reason as bplus-020: a repeat
  // call fails on "duplicate column name" and reports it as skipped.
  // Manager-only via the /api/migrate/ prefix rule in auth.js.
  if (path === "/api/migrate/drawer-021" && m === "POST") {
    const statements = [
      "ALTER TABLE cashdrawers ADD COLUMN closed_at TEXT",
    ];
    const applied = [];
    const skipped = [];
    for (const sql of statements) {
      try {
        await d1Run(env, sql);
        applied.push(sql);
      } catch (e) {
        skipped.push({ sql, reason: String(e.message || e) });
      }
    }
    return json({ ok: true, applied, skipped });
  }

  // One-shot: apply migration 026 — the station column that routes order
  // alerts to the station that owns them (a slow tea rings at the bar, not
  // the kitchen), the per-person target of the pickup ping, and the two
  // table columns behind the waiter's "bring the bill" request. Idempotent
  // like its siblings: repeats report "duplicate column name" as skipped.
  // Manager-only via the /api/migrate/ prefix rule in auth.js.
  if (path === "/api/migrate/alerts-026" && m === "POST") {
    const statements = [
      "ALTER TABLE alerts ADD COLUMN station TEXT DEFAULT ''",
      "ALTER TABLE alerts ADD COLUMN target_staff_id TEXT DEFAULT ''",
      "ALTER TABLE tables ADD COLUMN bill_requested_at TEXT DEFAULT ''",
      "ALTER TABLE tables ADD COLUMN bill_requested_by TEXT DEFAULT ''",
      "CREATE INDEX IF NOT EXISTS idx_alerts_status_rule ON alerts(status, rule_id)",
    ];
    const applied = [];
    const skipped = [];
    for (const sql of statements) {
      try {
        await d1Run(env, sql);
        applied.push(sql);
      } catch (e) {
        skipped.push({ sql, reason: String(e.message || e) });
      }
    }
    return json({ ok: true, applied, skipped });
  }

  // One-time repair: give every stored menu item a stable id.
  //
  // The KV blob was saved without per-item ids, so /api/menu served all 45 items
  // with id:"" and the POS cart could not tell one dish from another — adding a
  // macchiato to a cart holding a coffee merged into the coffee's line and billed
  // at the coffee's price.
  //
  // Manager-only via the /api/migrate/ prefix rule in auth.js. Idempotent: a
  // second run reports every item under alreadyHadId and writes nothing.
  //
  // ?force=1 also re-aligns ids that are already set. Use it when the public
  // /api/menu self-heal got there first and wrote deterministic ids that differ
  // from the ones D1 holds; it makes deploy-vs-repair ordering irrelevant.
  if (path === "/api/migrate/menu-ids" && m === "POST") {
    const force = ["1", "true", "yes"].includes(
      String(new URL(request.url).searchParams.get("force") || "").toLowerCase()
    );
    const data = await kvGetMenu(env);
    if (!isCategorized(data)) {
      return json({ ok: false, error: "Menu KV holds no categorized blob to repair" }, 409);
    }
    const report = await backfillMenuIdsFromD1(env, data, { force });
    const wrote = report.adopted + report.realigned + report.minted > 0;
    if (wrote) await kvSaveMenu(env, data);
    return json({ ok: true, force, wrote, ...report });
  }
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
