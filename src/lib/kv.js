var CONTENT_KV = "CONTENT_KV";

var CONTENT_KEY = "site:content";

var DRAFT_KEY = "site:content:draft";

var VERSIONS_KEY = "site:content:versions";

var MAX_VERSIONS = 50;

var KV_MAP = {
  menu: "MENU_KV",
  gallery: "GALLERY_KV"
};

async function kvGetList(env, collection) {
  const ns = KV_MAP[collection];
  if (!ns) return [];
  try {
    const raw = await env[ns].get("data");
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function kvSaveList(env, collection, items) {
  const ns = KV_MAP[collection];
  if (ns) await env[ns].put("data", JSON.stringify(items));
}
export { CONTENT_KV, CONTENT_KEY, DRAFT_KEY, VERSIONS_KEY, MAX_VERSIONS, KV_MAP, kvGetList, kvSaveList };
