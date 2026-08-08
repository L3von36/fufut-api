import { d1Query, json, readBody } from '../lib/db.js';
import { kvGetList, kvSaveList } from '../lib/kv.js';

async function handleGallery(pathname, method, request, env, ctx) {
  const m = method.toUpperCase();
  const sub = pathname.replace(/^\/api\/gallery/, "");
  if (m === "GET" && !sub) {
    const kvData = await kvGetList(env, "gallery");
    if (Array.isArray(kvData) && kvData.length > 0) return json(kvData);
    const { results } = await d1Query(env, "SELECT * FROM gallery ORDER BY created DESC");
    if (results.length > 0) {
      ctx.waitUntil(kvSaveList(env, "gallery", results));
    }
    return json(results || []);
  }
  if (m === "POST" && !sub) {
    const data = await readBody(request);
    if (!data) return json({ ok: false, error: "Invalid JSON body" }, 400);
    const items = await kvGetList(env, "gallery");
    if (Array.isArray(data)) {
      items.push(...data);
    } else {
      items.push(data);
    }
    await kvSaveList(env, "gallery", items);
    return json({ ok: true, count: Array.isArray(data) ? data.length : 1 });
  }
  if (m === "POST" && sub === "/save") {
    const data = await readBody(request);
    if (!Array.isArray(data)) return json({ ok: false, error: "Expected array" }, 400);
    await kvSaveList(env, "gallery", data);
    return json({ ok: true, count: data.length });
  }
  return null;
}
export { handleGallery };
