import { json, now, readBody, stripMeta, vid } from '../lib/db.js';
import { CONTENT_KEY, CONTENT_KV, DRAFT_KEY, MAX_VERSIONS, VERSIONS_KEY } from '../lib/kv.js';

async function getVersions(env) {
  try {
    const raw = await env[CONTENT_KV].get(VERSIONS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function saveVersions(env, versions) {
  await env[CONTENT_KV].put(VERSIONS_KEY, JSON.stringify(versions));
}

async function createVersion(env, content, note) {
  const versions = await getVersions(env);
  const entry = { id: vid(), timestamp: now(), note: note || "Manual save", status: "published", content };
  versions.push(entry);
  if (versions.length > MAX_VERSIONS) versions.splice(0, versions.length - MAX_VERSIONS);
  await saveVersions(env, versions);
  return entry.id;
}

async function checkScheduledPublish(env) {
  try {
    const raw = await env[CONTENT_KV].get(DRAFT_KEY);
    if (!raw) return;
    const draft = JSON.parse(raw);
    const scheduled = draft._meta && draft._meta.scheduled_at;
    if (!scheduled) return;
    if (/* @__PURE__ */ new Date() >= new Date(scheduled)) {
      const clean = stripMeta(draft);
      await env[CONTENT_KV].put(CONTENT_KEY, JSON.stringify(clean));
      await createVersion(env, clean, "Scheduled auto-publish");
      await env[CONTENT_KV].delete(DRAFT_KEY);
    }
  } catch (e) {
    console.error("[AUTO-PUBLISH ERROR]", e);
  }
}

async function handleContent(pathname, method, url, request, env) {
  const m = method.toUpperCase();
  if (pathname === "/api/content" && m === "GET") {
    const params = url.searchParams;
    const isDraft = params.get("draft") === "true" || params.get("preview") === "true";
    if (isDraft) {
      const raw2 = await env[CONTENT_KV].get(DRAFT_KEY);
      if (raw2) return json(stripMeta(JSON.parse(raw2)));
    }
    await checkScheduledPublish(env);
    const raw = await env[CONTENT_KV].get(CONTENT_KEY);
    return json(raw ? stripMeta(JSON.parse(raw)) : {});
  }
  if (pathname === "/api/content/status" && m === "GET") {
    const draftRaw = await env[CONTENT_KV].get(DRAFT_KEY);
    const pubRaw = await env[CONTENT_KV].get(CONTENT_KEY);
    const hasDraft = !!draftRaw;
    let dm = {}, pm = {};
    try {
      dm = JSON.parse(draftRaw)._meta || {};
    } catch {
    }
    try {
      pm = JSON.parse(pubRaw)._meta || {};
    } catch {
    }
    return json({ hasDraft, draftModified: dm.updated_at || "", publishedModified: pm.updated_at || "", scheduledAt: dm.scheduled_at || null, hasUnpublishedChanges: hasDraft });
  }
  if (pathname === "/api/content/versions" && m === "GET") {
    const versions = await getVersions(env);
    return json(versions.slice().reverse().map((v) => ({ id: v.id, timestamp: v.timestamp, note: v.note, status: v.status })));
  }
  if (/^\/api\/content\/versions\/[\w]+$/.test(pathname) && m === "GET") {
    const id = pathname.split("/").pop();
    const versions = await getVersions(env);
    for (let i = versions.length - 1; i >= 0; i--) {
      if (versions[i].id === id) return json({ id: versions[i].id, timestamp: versions[i].timestamp, note: versions[i].note, status: versions[i].status, content: stripMeta(versions[i].content) });
    }
    return json({ ok: false, error: "Version not found" }, 404);
  }
  if (pathname === "/api/content/draft" && m === "POST") {
    const data = await readBody(request);
    if (!data) return json({ ok: false, error: "Invalid JSON body" }, 400);
    data._meta = { updated_at: now(), status: "draft", scheduled_at: data._scheduled_at || null };
    delete data._scheduled_at;
    await env[CONTENT_KV].put(DRAFT_KEY, JSON.stringify(data));
    return json({ ok: true, message: "Draft saved" });
  }
  if (pathname === "/api/content/publish" && m === "POST") {
    const draftRaw = await env[CONTENT_KV].get(DRAFT_KEY);
    if (!draftRaw) return json({ ok: false, error: "No draft to publish" }, 400);
    const clean = stripMeta(JSON.parse(draftRaw));
    await env[CONTENT_KV].put(CONTENT_KEY, JSON.stringify(clean));
    const v = await createVersion(env, clean, "Published from draft");
    await env[CONTENT_KV].delete(DRAFT_KEY);
    return json({ ok: true, version: v, message: "Content published" });
  }
  if (pathname === "/api/content/schedule" && m === "POST") {
    const data = await readBody(request);
    const scheduled_at = data && data.scheduled_at;
    if (!scheduled_at) return json({ ok: false, error: "scheduled_at is required" }, 400);
    try {
      new Date(scheduled_at);
    } catch {
      return json({ ok: false, error: "Invalid datetime" }, 400);
    }
    const draftRaw = await env[CONTENT_KV].get(DRAFT_KEY);
    if (!draftRaw) return json({ ok: false, error: "No draft to schedule" }, 400);
    const draft = JSON.parse(draftRaw);
    draft._meta = draft._meta || {};
    draft._meta.scheduled_at = scheduled_at;
    draft._meta.status = "scheduled";
    await env[CONTENT_KV].put(DRAFT_KEY, JSON.stringify(draft));
    return json({ ok: true, message: "Scheduled for " + scheduled_at });
  }
  if (pathname === "/api/content/discard" && m === "POST") {
    await env[CONTENT_KV].delete(DRAFT_KEY);
    return json({ ok: true, message: "Draft discarded" });
  }
  if (/^\/api\/content\/rollback\/[\w]+$/.test(pathname) && m === "POST") {
    const id = pathname.split("/").pop();
    const versions = await getVersions(env);
    for (const v of versions) {
      if (v.id === id) {
        const clean = stripMeta(v.content);
        await env[CONTENT_KV].put(CONTENT_KEY, JSON.stringify(clean));
        const nv = await createVersion(env, clean, "Rollback to " + id);
        await env[CONTENT_KV].delete(DRAFT_KEY);
        return json({ ok: true, version: nv, message: "Rolled back to " + id });
      }
    }
    return json({ ok: false, error: "Version not found" }, 404);
  }
  if (pathname === "/api/content/save-and-publish" && m === "POST") {
    const data = await readBody(request);
    if (!data) return json({ ok: false, error: "Invalid JSON body" }, 400);
    const clean = stripMeta(data);
    await env[CONTENT_KV].put(CONTENT_KEY, JSON.stringify(clean));
    const v = await createVersion(env, clean, "Save & Publish");
    await env[CONTENT_KV].delete(DRAFT_KEY);
    return json({ ok: true, version: v, message: "Saved and published" });
  }
  if ((pathname === "/api/save-content" || pathname === "/save-content") && m === "POST") {
    const data = await readBody(request);
    if (!data) return json({ ok: false, error: "Invalid JSON body" }, 400);
    const clean = stripMeta(data);
    await env[CONTENT_KV].put(CONTENT_KEY, JSON.stringify(clean));
    const v = await createVersion(env, clean, "Save (legacy)");
    return json({ ok: true, version: v });
  }
  return null;
}
export { getVersions, saveVersions, createVersion, checkScheduledPublish, handleContent };
