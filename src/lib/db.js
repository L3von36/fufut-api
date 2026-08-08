var D1_BINDING = "DB";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function now() {
  return (/* @__PURE__ */ new Date()).toISOString();
}

function vid() {
  return "v" + crypto.randomUUID().slice(0, 8);
}

async function d1Query(env, sql, params = []) {
  return await env[D1_BINDING].prepare(sql).bind(...params).all();
}

async function d1Run(env, sql, params = []) {
  return await env[D1_BINDING].prepare(sql).bind(...params).run();
}

function stripMeta(content) {
  if (!content || typeof content !== "object") return content;
  const clean = {};
  for (const k of Object.keys(content)) {
    if (!k.startsWith("_")) clean[k] = content[k];
  }
  return clean;
}
export { D1_BINDING, json, readBody, now, vid, d1Query, d1Run, stripMeta };
