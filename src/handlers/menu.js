import { d1Query, d1Run, json, readBody } from '../lib/db.js';

function parseJsonSafe(str) {
  try {
    return JSON.parse(str);
  } catch {
    return [];
  }
}

function isCategorized(data) {
  return data && !Array.isArray(data) && Array.isArray(data.categories);
}

/**
 * Menu item identity.
 *
 * The KV menu blob was historically saved without per-item ids (the client never
 * sent them, and /api/menus/save passed items straight through). categorizedToFlat
 * then emitted `id: ""` for every item, so the POS cart — which matches lines by
 * `menuItemId === item.id` — treated all 45 items as the same product: adding a
 * macchiato to a cart holding a coffee merged into the coffee's line and billed at
 * the coffee's price.
 *
 * Ids are derived *deterministically* from category + name rather than randomly.
 * That matters because the same blob is read on every request: a random id would
 * differ between the read that renders the menu and the read that follows, so a
 * cart line could never match its item. A deterministic seed is stable even before
 * the self-healing write below has landed.
 *
 * Once seeded, the id is persisted into KV and reused verbatim, so a later rename
 * does not change an item's identity.
 */
function stableItemId(categoryName, itemName, occurrence) {
  // FNV-1a over the category+name pair. Short, stable, ASCII-safe, and does not
  // depend on crypto being seeded the same way across isolates.
  const seed = `${categoryName || ""}|${itemName || ""}`;
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hex = (h >>> 0).toString(16).padStart(8, "0");
  // Two items can legitimately share a name (the menu has two "Fut Special Gebeta"
  // at different prices). The occurrence index keeps those distinct.
  return occurrence > 0 ? `MI${hex}-${occurrence}` : `MI${hex}`;
}

/**
 * Ensure every item in a categorized menu blob carries a non-empty id.
 * Returns the blob plus whether anything had to be filled in, so callers can
 * decide to persist the repair.
 */
function ensureMenuIds(cat) {
  let changed = false;
  if (!isCategorized(cat)) return { data: cat, changed };
  const used = new Set();
  for (const c of cat.categories || []) {
    for (const item of c.items || []) {
      if (item.id) {
        used.add(item.id);
        continue;
      }
      let occurrence = 0;
      let candidate = stableItemId(c.name, item.name, occurrence);
      while (used.has(candidate)) {
        occurrence++;
        candidate = stableItemId(c.name, item.name, occurrence);
      }
      item.id = candidate;
      used.add(candidate);
      changed = true;
    }
  }
  return { data: cat, changed };
}

/**
 * Backfill ids onto an existing menu blob, preferring the ids D1 already holds.
 *
 * The D1 `menu_items` mirror was populated by earlier syncMenuToD1 runs, which
 * minted a random `MI<uuid>` for each id-less KV item and stored it only in D1.
 * So D1 has ids for all 45 items and KV has none, and the two sets are unrelated.
 *
 * Minting fresh deterministic ids into KV would leave those two id sets
 * competing: the next /api/menus/save would find none of D1's ids in the blob and
 * delete-then-reinsert every row. Matching on category+name and adopting the id
 * D1 already stores keeps the two stores agreeing and makes the next sync a no-op.
 *
 * Only items with no match fall back to a freshly derived id.
 *
 * `force` re-aligns ids that are already present. /api/menu is public and the
 * website polls it, so the lazy KV self-heal usually wins the race after a deploy
 * and writes *deterministic* ids before an operator can call this. Those ids are
 * correct but differ from D1's, leaving the two stores disagreeing. Running with
 * force replaces them with D1's ids so the mirror lines up again, which makes the
 * ordering of deploy vs. repair stop mattering.
 *
 * Existing ids are snapshotted and cleared before matching, so an id already sat
 * on one item cannot block the item that should legitimately adopt it. Anything
 * D1 has no row for keeps the id it came in with rather than being churned.
 */
async function backfillMenuIdsFromD1(env, catData, { force = false } = {}) {
  const report = { total: 0, alreadyHadId: 0, adopted: 0, realigned: 0, unchanged: 0, kept: 0, minted: 0 };
  if (!isCategorized(catData)) return report;

  let rows = [];
  try {
    const { results } = await d1Query(
      env,
      "SELECT mi.id AS id, mi.name AS name, c.name AS category FROM menu_items mi LEFT JOIN categories c ON c.id = mi.category_id"
    );
    rows = results || [];
  } catch {
    rows = [];
  }

  // category|name -> queue of ids. A queue rather than a single value because
  // the menu genuinely carries two dishes sharing a name.
  const pools = new Map();
  for (const r of rows) {
    const key = `${r.category || ""}|${r.name || ""}`;
    if (!pools.has(key)) pools.set(key, []);
    pools.get(key).push(r.id);
  }

  // Snapshot what each item arrived with. Under force everything is cleared so
  // that matching is not blocked by an id already sitting on another item.
  const previous = new Map();
  for (const c of catData.categories || []) {
    for (const item of c.items || []) {
      previous.set(item, item.id || "");
      if (force) item.id = "";
    }
  }

  const used = new Set();
  for (const c of catData.categories || []) {
    for (const item of c.items || []) {
      if (item.id) used.add(item.id);
    }
  }

  for (const c of catData.categories || []) {
    for (const item of c.items || []) {
      report.total++;
      if (item.id) {
        report.alreadyHadId++;
        continue;
      }
      const pool = pools.get(`${c.name || ""}|${item.name || ""}`);
      let adopted = null;
      while (pool && pool.length) {
        const candidate = pool.shift();
        if (candidate && !used.has(candidate)) {
          adopted = candidate;
          break;
        }
      }
      const prior = previous.get(item) || "";
      if (adopted) {
        item.id = adopted;
        used.add(adopted);
        if (!prior) report.adopted++;
        else if (prior === adopted) report.unchanged++;
        else report.realigned++;
        continue;
      }
      // D1 has no row for this item. Keep whatever id it already had rather than
      // churning it; only a genuinely id-less item gets a derived one.
      if (prior && !used.has(prior)) {
        item.id = prior;
        used.add(prior);
        report.kept++;
        continue;
      }
      let occurrence = 0;
      let minted = stableItemId(c.name, item.name, occurrence);
      while (used.has(minted)) {
        occurrence++;
        minted = stableItemId(c.name, item.name, occurrence);
      }
      item.id = minted;
      used.add(minted);
      report.minted++;
    }
  }
  return report;
}

function categorizedToFlat(cat) {
  const out = [];
  for (const c of cat.categories || []) {
    for (const item of c.items || []) {
      out.push({
        id: item.id || "",
        name: item.name || "",
        category: c.name || "",
        price: Number(item.price) || 0,
        cost: Number(item.cost) || 0,
        description: item.description || "",
        image: item.image || "",
        available: item.available !== false,
        modifiers: item.modifiers || [],
        tags: item.tags || [],
        ...item.created ? { created: item.created } : {}
      });
    }
  }
  return out;
}

async function kvGetMenu(env) {
  try {
    const raw = await env.MENU_KV.get("data");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function kvSaveMenu(env, data) {
  await env.MENU_KV.put("data", JSON.stringify(data));
}

async function d1GetMenuCategorized(env) {
  const { results: categories } = await d1Query(env, "SELECT * FROM categories ORDER BY sort_order, name");
  const { results: items } = await d1Query(env, "SELECT * FROM menu_items ORDER BY sort_order, name");
  const catMap = {};
  for (const c of categories) {
    catMap[c.id] = { name: c.name, ...c.name_am ? { name_am: c.name_am } : {}, items: [] };
  }
  for (const item of items) {
    const cat = catMap[item.category_id];
    if (cat) {
      const obj = {
        id: item.id,
        name: item.name,
        description: item.description || "",
        price: Number(item.price) || 0,
        cost: Number(item.cost) || 0,
        image: item.image || "",
        available: item.available === 1,
        modifiers: parseJsonSafe(item.modifiers),
        tags: parseJsonSafe(item.tags),
        created: item.created || ""
      };
      if (item.name_am) obj.name_am = item.name_am;
      if (item.description_am) obj.description_am = item.description_am;
      cat.items.push(obj);
    }
  }
  return { restaurant: "FU FUT COFFEE", categories: categories.map((c) => catMap[c.id] || { name: c.name, items: [] }) };
}

async function syncMenuToD1(env, catData) {
  try {
    const existingItems = (await d1Query(env, "SELECT id FROM menu_items")).results;
    const existingItemIds = new Set(existingItems.map((i) => i.id));
    const seenItemIds = /* @__PURE__ */ new Set();
    for (let ci = 0; ci < catData.categories.length; ci++) {
      const catData_item = catData.categories[ci];
      const catName = catData_item.name || "Other";
      const catNameAm = catData_item.name_am || "";
      const { results: catRows } = await d1Query(env, "SELECT id FROM categories WHERE name = ?", [catName]);
      let catId = catRows.length > 0 ? catRows[0].id : null;
      if (!catId) {
        catId = "C" + crypto.randomUUID().slice(0, 8);
        await d1Run(env, "INSERT INTO categories (id, name, name_am, sort_order) VALUES (?, ?, ?, ?)", [catId, catName, catNameAm, ci]);
      } else {
        await d1Run(env, "UPDATE categories SET name_am = ?, sort_order = ? WHERE id = ?", [catNameAm, ci, catId]);
      }
      for (const item of catData_item.items || []) {
        const itemId = item.id || "MI" + crypto.randomUUID().slice(0, 8);
        seenItemIds.add(itemId);
        const price = Number(item.price) || 0;
        const cost = Number(item.cost) || 0;
        const modifiers = JSON.stringify(Array.isArray(item.modifiers) ? item.modifiers : []);
        const tags = JSON.stringify(Array.isArray(item.tags) ? item.tags : []);
        const available = item.available !== false ? 1 : 0;
        if (existingItemIds.has(itemId)) {
          await d1Run(
            env,
            "UPDATE menu_items SET category_id=?, name=?, name_am=?, description=?, description_am=?, price=?, cost=?, modifiers=?, available=?, image=?, tags=? WHERE id=?",
            [catId, item.name || "", item.name_am || "", item.description || "", item.description_am || "", price, cost, modifiers, available, item.image || "", tags, itemId]
          );
        } else {
          await d1Run(
            env,
            "INSERT INTO menu_items (id, category_id, name, name_am, description, description_am, price, cost, modifiers, available, sort_order, image, tags) VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?)",
            [itemId, catId, item.name || "", item.name_am || "", item.description || "", item.description_am || "", price, cost, modifiers, available, item.image || "", tags]
          );
        }
      }
    }
    for (const existingId of existingItemIds) {
      if (!seenItemIds.has(existingId)) {
        await d1Run(env, "DELETE FROM menu_items WHERE id = ?", [existingId]);
      }
    }
  } catch (e) {
    console.error("[D1 SYNC ERROR]", e);
  }
}

async function syncItemToD1(env, action, item) {
  try {
    if (action === "delete") {
      await d1Run(env, "DELETE FROM menu_items WHERE id = ?", [item.id]);
      return;
    }
    const catName = item.category || "Other";
    const { results: catRows } = await d1Query(env, "SELECT id FROM categories WHERE name = ?", [catName]);
    let catId = catRows.length > 0 ? catRows[0].id : null;
    if (!catId) {
      catId = "C" + crypto.randomUUID().slice(0, 8);
      await d1Run(env, "INSERT INTO categories (id, name, sort_order) VALUES (?, ?, 0)", [catId, catName]);
    }
    if (action === "insert") {
      await d1Run(
        env,
        "INSERT OR REPLACE INTO menu_items (id, category_id, name, name_am, description, description_am, price, cost, modifiers, available, sort_order, image, tags) VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?)",
        [item.id, catId, item.name || "", item.name_am || "", item.description || "", item.description_am || "", Number(item.price) || 0, Number(item.cost) || 0, JSON.stringify(item.modifiers || []), item.available !== false ? 1 : 0, item.image || "", JSON.stringify(item.tags || [])]
      );
    } else if (action === "update") {
      const fields = [];
      const values = [];
      if (item.name !== void 0) {
        fields.push("name=?");
        values.push(item.name);
      }
      if (item.name_am !== void 0) {
        fields.push("name_am=?");
        values.push(item.name_am || "");
      }
      if (item.description !== void 0) {
        fields.push("description=?");
        values.push(item.description);
      }
      if (item.description_am !== void 0) {
        fields.push("description_am=?");
        values.push(item.description_am || "");
      }
      if (item.price !== void 0) {
        fields.push("price=?");
        values.push(Number(item.price) || 0);
      }
      if (item.cost !== void 0) {
        fields.push("cost=?");
        values.push(Number(item.cost) || 0);
      }
      if (item.modifiers !== void 0) {
        fields.push("modifiers=?");
        values.push(JSON.stringify(item.modifiers));
      }
      if (item.available !== void 0) {
        fields.push("available=?");
        values.push(item.available ? 1 : 0);
      }
      if (item.image !== void 0) {
        fields.push("image=?");
        values.push(item.image);
      }
      if (item.tags !== void 0) {
        fields.push("tags=?");
        values.push(JSON.stringify(item.tags || []));
      }
      fields.push("category_id=?");
      values.push(catId);
      if (fields.length > 0) {
        values.push(item.id);
        await d1Run(env, `UPDATE menu_items SET ${fields.join(",")} WHERE id=?`, values);
      }
    }
  } catch (e) {
    console.error("[D1 ITEM SYNC ERROR]", e);
  }
}

async function handleMenu(pathname, method, request, env, ctx) {
  const m = method.toUpperCase();
  if (m === "GET" && pathname === "/api/menus") {
    let data = await kvGetMenu(env);
    if (!data || !isCategorized(data)) {
      data = await d1GetMenuCategorized(env);
      if (data.categories.length > 0) {
        ctx.waitUntil(kvSaveMenu(env, data));
      }
    } else {
      // Self-heal legacy blobs that predate per-item ids.
      //
      // Deliberately KV-only: syncMenuToD1 ends by DELETEing any menu_items row
      // whose id is absent from the blob, and the existing D1 rows carry older
      // randomly-minted ids that will not match the deterministic ones. Calling
      // it from here would make a GET delete and re-insert all 45 rows and reset
      // their sort_order. /api/menu reads from KV, so the KV write alone fixes
      // the blank-id bug; D1 is reconciled by the next /api/menus/save.
      const { changed } = ensureMenuIds(data);
      if (changed) ctx.waitUntil(kvSaveMenu(env, data));
    }
    return json(data);
  }
  if (m === "GET" && pathname === "/api/menu") {
    let data = await kvGetMenu(env);
    if (!data || !isCategorized(data)) {
      data = await d1GetMenuCategorized(env);
      if (data.categories.length > 0) {
        ctx.waitUntil(kvSaveMenu(env, data));
      }
    } else {
      // KV-only for the same reason as /api/menus above: a read must not trigger
      // syncMenuToD1's DELETE pass.
      const { changed } = ensureMenuIds(data);
      if (changed) ctx.waitUntil(kvSaveMenu(env, data));
    }
    return json(categorizedToFlat(data));
  }
  if (m === "POST" && pathname === "/api/menus/save") {
    const data = await readBody(request);
    if (!data || !Array.isArray(data.categories)) return json({ ok: false, error: "Expected {categories:[...]}" }, 400);
    const catPayload = {
      restaurant: data.restaurant || "FU FUT COFFEE",
      categories: data.categories.map((c) => ({
        name: c.name,
        items: (c.items || []).map((item) => ({
          ...item,
          price: Number(item.price) || 0,
          ...item.cost !== void 0 ? { cost: Number(item.cost) || 0 } : {}
        }))
      }))
    };
    // Assign ids before the blob is stored, so KV and D1 agree from the outset.
    // syncMenuToD1 also mints ids for id-less items, but only ever wrote them to
    // D1 — the KV copy stayed id-less, which is how the blank-id state persisted.
    ensureMenuIds(catPayload);
    const totalItems = catPayload.categories.reduce((s, c) => s + (c.items || []).length, 0);
    await kvSaveMenu(env, catPayload);
    ctx.waitUntil(syncMenuToD1(env, catPayload));
    return json({ ok: true, count: totalItems });
  }
  if (m === "POST" && pathname === "/api/menu") {
    const data = await readBody(request);
    if (!data) return json({ ok: false, error: "Invalid JSON body" }, 400);
    if (data.price !== void 0) data.price = Number(data.price) || 0;
    if (data.cost !== void 0) data.cost = Number(data.cost) || 0;
    if (!data.id) data.id = "MI" + crypto.randomUUID().slice(0, 8);
    const stored = await kvGetMenu(env);
    if (isCategorized(stored)) {
      const catName = data.category || "Other";
      let cat = stored.categories.find((c) => c.name === catName);
      if (!cat) {
        cat = { name: catName, items: [] };
        stored.categories.push(cat);
      }
      const { category, ...itemFields } = data;
      cat.items.push(itemFields);
      await kvSaveMenu(env, stored);
      ctx.waitUntil(syncMenuToD1(env, stored));
    } else {
      const catName = data.category || "Other";
      const { results: catRows } = await d1Query(env, "SELECT id FROM categories WHERE name = ?", [catName]);
      let catId = catRows.length > 0 ? catRows[0].id : null;
      if (!catId) {
        catId = "C" + crypto.randomUUID().slice(0, 8);
        await d1Run(env, "INSERT INTO categories (id, name, sort_order) VALUES (?, ?, 0)", [catId, catName]);
      }
      await d1Run(
        env,
        "INSERT INTO menu_items (id, category_id, name, name_am, description, description_am, price, cost, modifiers, available, sort_order, image, tags) VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?)",
        [data.id, catId, data.name || "", data.name_am || "", data.description || "", data.description_am || "", data.price, data.cost || 0, JSON.stringify(data.modifiers || []), data.available !== false ? 1 : 0, data.image || "", JSON.stringify(data.tags || [])]
      );
      const rebuilt = await d1GetMenuCategorized(env);
      await kvSaveMenu(env, rebuilt);
    }
    return json({ ok: true, id: data.id });
  }
  if (m === "PUT" && pathname.match(/^\/api\/menu\/[^/]+$/)) {
    const id = pathname.split("/").pop();
    const data = await readBody(request);
    if (!data) return json({ ok: false, error: "Invalid JSON body" }, 400);
    if (data.price !== void 0) data.price = Number(data.price) || 0;
    if (data.cost !== void 0) data.cost = Number(data.cost) || 0;
    const stored = await kvGetMenu(env);
    if (isCategorized(stored)) {
      let found = false;
      for (const cat of stored.categories) {
        for (let i = 0; i < cat.items.length; i++) {
          if (cat.items[i].id === id) {
            const { category, ...updateFields } = data;
            if (category && category !== cat.name) {
              cat.items.splice(i, 1);
              let targetCat = stored.categories.find((c) => c.name === category);
              if (!targetCat) {
                targetCat = { name: category, items: [] };
                stored.categories.push(targetCat);
              }
              updateFields.id = id;
              targetCat.items.push(updateFields);
            } else {
              cat.items[i] = { ...cat.items[i], ...updateFields, id };
            }
            found = true;
            break;
          }
        }
        if (found) break;
      }
      if (!found) return json({ ok: false, error: "Menu item not found" }, 404);
      await kvSaveMenu(env, stored);
      ctx.waitUntil(syncItemToD1(env, "update", { ...data, id }));
      return json({ ok: true });
    } else {
      return json({ ok: false, error: "Menu data not found" }, 404);
    }
  }
  if (m === "PUT" && pathname === "/api/menu") {
    const data = await readBody(request);
    if (!data || !data.id) return json({ ok: false, error: "Item with id is required" }, 400);
    if (data.price !== void 0) data.price = Number(data.price) || 0;
    if (data.cost !== void 0) data.cost = Number(data.cost) || 0;
    const stored = await kvGetMenu(env);
    if (isCategorized(stored)) {
      let found = false;
      for (const cat of stored.categories) {
        for (let i = 0; i < cat.items.length; i++) {
          if (cat.items[i].id === data.id) {
            const { category, ...updateFields } = data;
            if (category && category !== cat.name) {
              cat.items.splice(i, 1);
              let targetCat = stored.categories.find((c) => c.name === category);
              if (!targetCat) {
                targetCat = { name: category, items: [] };
                stored.categories.push(targetCat);
              }
              updateFields.id = data.id;
              targetCat.items.push(updateFields);
            } else {
              cat.items[i] = { ...cat.items[i], ...updateFields, id: data.id };
            }
            found = true;
            break;
          }
        }
        if (found) break;
      }
      if (!found) return json({ ok: false, error: "Menu item not found" }, 404);
      await kvSaveMenu(env, stored);
      ctx.waitUntil(syncItemToD1(env, "update", data));
      return json({ ok: true });
    } else {
      return json({ ok: false, error: "Menu data not found" }, 404);
    }
  }
  if (m === "DELETE" && pathname.match(/^\/api\/menu\/[^/]+$/)) {
    const id = pathname.split("/").pop();
    const stored = await kvGetMenu(env);
    if (isCategorized(stored)) {
      let found = false;
      for (const cat of stored.categories) {
        const idx = cat.items.findIndex((it) => it.id === id);
        if (idx !== -1) {
          cat.items.splice(idx, 1);
          found = true;
          break;
        }
      }
      if (!found) return json({ ok: false, error: "Menu item not found" }, 404);
      await kvSaveMenu(env, stored);
      ctx.waitUntil(syncItemToD1(env, "delete", { id }));
      return json({ ok: true });
    } else {
      return json({ ok: false, error: "Menu data not found" }, 404);
    }
  }
  return null;
}
export { parseJsonSafe, isCategorized, stableItemId, ensureMenuIds, backfillMenuIdsFromD1, categorizedToFlat, kvGetMenu, kvSaveMenu, d1GetMenuCategorized, syncMenuToD1, syncItemToD1, handleMenu };
