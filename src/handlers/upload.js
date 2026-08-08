import { json, now } from '../lib/db.js';

async function handleUpload(request, env) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!file) return json({ ok: false, error: "No file" }, 400);
    const key = "uploads/" + Date.now() + "-" + file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    await env.IMAGES_R2.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
    return json({ ok: true, url: "https://images.futfutcoffee.com/" + key, key });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
}
export { handleUpload };
